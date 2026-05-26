package iothub

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

// GenerateSASToken mints an Azure IoT Hub SAS token of the form
//
//	SharedAccessSignature sr=<url-encoded-resource>&sig=<sig>&se=<unix-expiry>
//
// where <resource> is "<host>/devices/<deviceID>" and <sig> is
// HMAC-SHA256(base64-decode(sharedAccessKey), <url-encoded-resource>+"\n"+<expiry>),
// base64-encoded then url-encoded.
//
// `skn` (policy name) is intentionally omitted: this is a device-scoped
// SAS minted from the device's own key.
func GenerateSASToken(hostName, deviceID, sharedAccessKey string, ttl time.Duration) (string, time.Time, error) {
	if ttl <= 0 {
		return "", time.Time{}, fmt.Errorf("iothub: SAS token TTL must be positive, got %s", ttl)
	}
	expiryUnix := time.Now().Add(ttl).Unix()
	return generateSASTokenAt(hostName, deviceID, sharedAccessKey, expiryUnix)
}

// generateSASTokenAt is the deterministic core of GenerateSASToken with
// the expiry pinned. Kept package-private so tests can pin the expiry
// and assert byte-equal token output.
func generateSASTokenAt(hostName, deviceID, sharedAccessKey string, expiryUnix int64) (string, time.Time, error) {
	if hostName == "" {
		return "", time.Time{}, fmt.Errorf("iothub: SAS token requires non-empty hostName")
	}
	if deviceID == "" {
		return "", time.Time{}, fmt.Errorf("iothub: SAS token requires non-empty deviceID")
	}

	resource := hostName + "/devices/" + deviceID
	encodedResource := url.QueryEscape(resource)
	expiryStr := strconv.FormatInt(expiryUnix, 10)
	stringToSign := encodedResource + "\n" + expiryStr

	keyBytes, err := base64.StdEncoding.DecodeString(sharedAccessKey)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("iothub: SharedAccessKey is not valid base64: %w", err)
	}

	mac := hmac.New(sha256.New, keyBytes)
	if _, err := mac.Write([]byte(stringToSign)); err != nil {
		return "", time.Time{}, fmt.Errorf("iothub: HMAC write failed: %w", err)
	}
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	token := fmt.Sprintf(
		"SharedAccessSignature sr=%s&sig=%s&se=%s",
		encodedResource, url.QueryEscape(sig), expiryStr,
	)
	return token, time.Unix(expiryUnix, 0), nil
}
