// Package identity is the device's own X.509 identity: an ECDSA P-256 key
// generated on the device, which never leaves it, and a self-signed client
// certificate whose subject CN is the device id. The certificate (never the
// key) is what an operator enrols in the Device Provisioning Service; the
// device then proves it holds the key in the TLS handshake with DPS and with
// IoT Hub.
//
// Files, under <stateDir>/identity (mode 0700):
//
//	device.key  PKCS#8 PEM private key, mode 0600
//	device.crt  PEM certificate, mode 0644
//
// Ensure creates them once and afterwards only reads them. Nothing in this
// package logs, prints or returns the key as PEM.
package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/atomicfile"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
)

const (
	// DirName is the identity directory under the state dir.
	DirName = "identity"
	// KeyFile and CertFile are the file names inside DirName.
	KeyFile  = "device.key"
	CertFile = "device.crt"

	dirPerm  os.FileMode = 0o700
	keyPerm  os.FileMode = 0o600
	certPerm os.FileMode = 0o644

	// notBeforeSkew backdates the certificate so a peer whose clock runs a
	// little behind the device's still accepts it.
	notBeforeSkew = 5 * time.Minute
	validYears    = 5
)

// deviceIDPattern is what DPS accepts as a registration id (alphanumerics and
// - . _ :, at most 128), which in this design is also the IoT Hub device id
// and the certificate CN.
var deviceIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// Dir is the identity directory for stateDir.
func Dir(stateDir string) string { return filepath.Join(stateDir, DirName) }

// ValidateDeviceID reports whether id can be a DPS registration id.
func ValidateDeviceID(id string) error {
	if !deviceIDPattern.MatchString(id) {
		return fmt.Errorf("identity: device id %q is not valid: use 1 to 128 letters, digits, '-', '.', '_' or ':'", id)
	}
	return nil
}

// Ensure returns the device's certificate PEM and the key pair for TLS,
// creating both on the first call. Later calls load the stored pair and never
// replace it. It fails, naming both ids, when the stored certificate's CN is
// not deviceID (the device id must not change under an existing key), and when
// the key file's permissions are wider than 0600.
func Ensure(stateDir, deviceID string, clk clock.Clock) (certPEM []byte, cert tls.Certificate, err error) {
	if err := ValidateDeviceID(deviceID); err != nil {
		return nil, tls.Certificate{}, err
	}
	if clk == nil {
		clk = clock.Real()
	}
	dir := Dir(stateDir)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return nil, tls.Certificate{}, fmt.Errorf("identity: create %s: %w", dir, err)
	}
	if err := os.Chmod(dir, dirPerm); err != nil {
		return nil, tls.Certificate{}, fmt.Errorf("identity: chmod %s: %w", dir, err)
	}
	keyPath, certPath := filepath.Join(dir, KeyFile), filepath.Join(dir, CertFile)

	keyExists, err := exists(keyPath)
	if err != nil {
		return nil, tls.Certificate{}, err
	}
	certExists, err := exists(certPath)
	if err != nil {
		return nil, tls.Certificate{}, err
	}
	switch {
	case certExists && !keyExists:
		return nil, tls.Certificate{}, fmt.Errorf("identity: %s exists but %s does not; the key is gone, so this certificate can never be used again. Remove %s to create a new identity, then enrol the new certificate", certPath, keyPath, certPath)
	case !keyExists:
		if err := createKey(keyPath); err != nil {
			return nil, tls.Certificate{}, err
		}
		fallthrough
	case !certExists:
		// The key exists without a certificate only when a first run stopped
		// between the two writes; no certificate has been shown to anyone, so
		// minting one for that key is safe.
		if err := createCert(keyPath, certPath, deviceID, clk.Now()); err != nil {
			return nil, tls.Certificate{}, err
		}
	}
	// Always finish by reading what is on disk, so a process that lost a race
	// to create the files returns the winner's pair.
	return load(keyPath, certPath, deviceID)
}

func exists(path string) (bool, error) {
	_, err := os.Lstat(path)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, os.ErrNotExist):
		return false, nil
	default:
		return false, fmt.Errorf("identity: stat %s: %w", path, err)
	}
}

// createKey writes a new P-256 key to keyPath unless one is already there.
func createKey(keyPath string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("identity: generate key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return fmt.Errorf("identity: encode key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err := atomicfile.WriteNew(keyPath, keyPEM, keyPerm); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("identity: write key: %w", err)
	}
	return nil
}

// createCert signs a self-signed client certificate for the key in keyPath
// and writes it to certPath unless one is already there.
func createCert(keyPath, certPath, deviceID string, now time.Time) error {
	key, err := readKey(keyPath)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("identity: serial number: %w", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: deviceID},
		NotBefore:             now.Add(-notBeforeSkew),
		NotAfter:              now.AddDate(validYears, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		return fmt.Errorf("identity: sign certificate: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := atomicfile.WriteNew(certPath, certPEM, certPerm); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("identity: write certificate: %w", err)
	}
	return nil
}

// readKey reads the key file after checking its permissions. Errors never
// carry the file's contents.
func readKey(keyPath string) (*ecdsa.PrivateKey, error) {
	keyPEM, err := readKeyFile(keyPath)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(keyPEM)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("identity: %s is not a PKCS#8 PEM private key", keyPath)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("identity: %s does not hold a valid PKCS#8 key", keyPath)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("identity: %s is not an ECDSA P-256 key", keyPath)
	}
	return key, nil
}

func readKeyFile(keyPath string) ([]byte, error) {
	info, err := os.Lstat(keyPath)
	if err != nil {
		return nil, fmt.Errorf("identity: stat %s: %w", keyPath, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("identity: %s is not a regular file", keyPath)
	}
	if perm := info.Mode().Perm(); perm&^keyPerm != 0 {
		return nil, fmt.Errorf("identity: %s has permissions %04o, wider than 0600; run chmod 600 %s", keyPath, perm, keyPath)
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("identity: read %s: %w", keyPath, err)
	}
	return keyPEM, nil
}

// load reads and checks the stored pair.
func load(keyPath, certPath, deviceID string) ([]byte, tls.Certificate, error) {
	keyPEM, err := readKeyFile(keyPath)
	if err != nil {
		return nil, tls.Certificate{}, err
	}
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, tls.Certificate{}, fmt.Errorf("identity: read %s: %w", certPath, err)
	}
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, tls.Certificate{}, fmt.Errorf("identity: %s is not a PEM certificate", certPath)
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, tls.Certificate{}, fmt.Errorf("identity: parse %s: %w", certPath, err)
	}
	if cn := leaf.Subject.CommonName; cn != deviceID {
		return nil, tls.Certificate{}, fmt.Errorf("identity: the stored certificate %s is for device id %q, not %q; the device id must not change under an existing key (set the device id back to %q, or remove %s to create a new identity and enrol it)", certPath, cn, deviceID, cn, filepath.Dir(certPath))
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		// tls's errors name the mismatch, never the key bytes.
		return nil, tls.Certificate{}, fmt.Errorf("identity: %s and %s do not form a key pair: %w", keyPath, certPath, err)
	}
	pair.Leaf = leaf
	return certPEM, pair, nil
}
