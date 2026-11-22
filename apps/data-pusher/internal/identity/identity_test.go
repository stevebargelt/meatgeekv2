package identity

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
)

var start = time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

func parseCert(t *testing.T, certPEM []byte) *x509.Certificate {
	t.Helper()
	block, rest := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatalf("not a PEM certificate: %q", certPEM)
	}
	if len(bytes.TrimSpace(rest)) != 0 {
		t.Fatalf("trailing data after the certificate: %q", rest)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	return cert
}

func perm(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestEnsure_CreatesP256KeyAndSelfSignedClientCert(t *testing.T) {
	state := t.TempDir()
	certPEM, pair, err := Ensure(state, "meatgeek-pi-7", clocktest.New(start))
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if bytes.Contains(certPEM, []byte("PRIVATE KEY")) {
		t.Fatal("certificate PEM carries a private key")
	}
	cert := parseCert(t, certPEM)

	if cert.Subject.CommonName != "meatgeek-pi-7" {
		t.Errorf("CN = %q", cert.Subject.CommonName)
	}
	// Self-signed: issued by itself and signed by its own key. (A leaf cannot
	// pass CheckSignatureFrom itself, which wants a CA parent.)
	if !bytes.Equal(cert.RawIssuer, cert.RawSubject) {
		t.Errorf("issuer %q is not the subject", cert.Issuer)
	}
	if err := cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature); err != nil {
		t.Errorf("not signed by its own key: %v", err)
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		t.Errorf("public key is %T, want ECDSA P-256", cert.PublicKey)
	}
	if cert.KeyUsage != x509.KeyUsageDigitalSignature {
		t.Errorf("KeyUsage = %v, want DigitalSignature only", cert.KeyUsage)
	}
	if len(cert.ExtKeyUsage) != 1 || cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Errorf("ExtKeyUsage = %v, want [ClientAuth]", cert.ExtKeyUsage)
	}
	if cert.IsCA {
		t.Error("certificate is a CA")
	}
	if want := start.Add(-5 * time.Minute); !cert.NotBefore.Equal(want) {
		t.Errorf("NotBefore = %v, want %v", cert.NotBefore, want)
	}
	if want := start.AddDate(5, 0, 0); !cert.NotAfter.Equal(want) {
		t.Errorf("NotAfter = %v, want %v", cert.NotAfter, want)
	}
	if cert.SerialNumber.Sign() <= 0 || cert.SerialNumber.Cmp(new(big.Int).Lsh(big.NewInt(1), 128)) >= 0 {
		t.Errorf("serial %v is not a positive 128-bit number", cert.SerialNumber)
	}

	// The returned pair is the stored key and this certificate.
	if !bytes.Equal(pair.Certificate[0], cert.Raw) {
		t.Error("tls.Certificate does not carry the returned certificate")
	}
	priv, ok := pair.PrivateKey.(*ecdsa.PrivateKey)
	if !ok || !priv.PublicKey.Equal(pub) {
		t.Error("tls.Certificate's key does not match the certificate")
	}

	dir := filepath.Join(state, "identity")
	if got := perm(t, dir); got != 0o700 {
		t.Errorf("identity dir mode = %04o, want 0700", got)
	}
	if got := perm(t, filepath.Join(dir, "device.key")); got != 0o600 {
		t.Errorf("device.key mode = %04o, want 0600", got)
	}
	if got := perm(t, filepath.Join(dir, "device.crt")); got != 0o644 {
		t.Errorf("device.crt mode = %04o, want 0644", got)
	}
	keyPEM, err := os.ReadFile(filepath.Join(dir, "device.key"))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(keyPEM)
	if block == nil || block.Type != "PRIVATE KEY" {
		t.Fatalf("device.key is not a PKCS#8 PEM block")
	}
	if _, err := x509.ParsePKCS8PrivateKey(block.Bytes); err != nil {
		t.Errorf("device.key is not PKCS#8: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Errorf("identity dir holds %d entries, want device.key and device.crt only (no temp files)", len(entries))
	}
}

func TestEnsure_SecondCallReturnsTheSameCertificate(t *testing.T) {
	state := t.TempDir()
	clk := clocktest.New(start)
	first, _, err := Ensure(state, "dev-1", clk)
	if err != nil {
		t.Fatal(err)
	}
	keyBefore, err := os.ReadFile(filepath.Join(state, "identity", "device.key"))
	if err != nil {
		t.Fatal(err)
	}
	clk.Advance(48 * time.Hour)
	second, _, err := Ensure(state, "dev-1", clk)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Error("second Ensure returned a different certificate")
	}
	keyAfter, err := os.ReadFile(filepath.Join(state, "identity", "device.key"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(keyBefore, keyAfter) {
		t.Error("second Ensure replaced the key")
	}
}

func TestEnsure_StoredCertificateForAnotherDeviceIsAnError(t *testing.T) {
	state := t.TempDir()
	if _, _, err := Ensure(state, "dev-old", clocktest.New(start)); err != nil {
		t.Fatal(err)
	}
	_, _, err := Ensure(state, "dev-new", clocktest.New(start))
	if err == nil {
		t.Fatal("Ensure accepted a stored certificate for another device id")
	}
	for _, id := range []string{"dev-old", "dev-new"} {
		if !strings.Contains(err.Error(), id) {
			t.Errorf("error %q does not name %q", err, id)
		}
	}
}

func TestEnsure_KeyFileWiderThan0600IsAnError(t *testing.T) {
	state := t.TempDir()
	if _, _, err := Ensure(state, "dev-1", clocktest.New(start)); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(state, "identity", "device.key")
	if err := os.Chmod(keyPath, 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, err := Ensure(state, "dev-1", clocktest.New(start))
	if err == nil {
		t.Fatal("Ensure accepted a 0644 key file")
	}
	if !strings.Contains(err.Error(), "0644") {
		t.Errorf("error %q does not name the mode", err)
	}
	if strings.Contains(err.Error(), "PRIVATE KEY") {
		t.Errorf("error leaks the key: %q", err)
	}
}

func TestEnsure_KeyWithoutCertificateGetsOneAndKeepsTheKey(t *testing.T) {
	state := t.TempDir()
	if _, _, err := Ensure(state, "dev-1", clocktest.New(start)); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(state, "identity")
	keyBefore, err := os.ReadFile(filepath.Join(dir, "device.key"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "device.crt")); err != nil {
		t.Fatal(err)
	}
	_, pair, err := Ensure(state, "dev-1", clocktest.New(start))
	if err != nil {
		t.Fatalf("Ensure after a lost certificate: %v", err)
	}
	keyAfter, err := os.ReadFile(filepath.Join(dir, "device.key"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(keyBefore, keyAfter) {
		t.Error("the key was replaced")
	}
	if pair.Leaf == nil || pair.Leaf.Subject.CommonName != "dev-1" {
		t.Error("no certificate for the kept key")
	}
}

func TestEnsure_CertificateWithoutKeyIsAnError(t *testing.T) {
	state := t.TempDir()
	if _, _, err := Ensure(state, "dev-1", clocktest.New(start)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(state, "identity", "device.key")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Ensure(state, "dev-1", clocktest.New(start)); err == nil {
		t.Fatal("Ensure accepted a certificate whose key is gone")
	}
}

func TestEnsure_RejectsInvalidDeviceID(t *testing.T) {
	for _, id := range []string{"", "has space", "../escape", strings.Repeat("a", 129)} {
		if _, _, err := Ensure(t.TempDir(), id, clocktest.New(start)); err == nil {
			t.Errorf("Ensure accepted device id %q", id)
		}
	}
}
