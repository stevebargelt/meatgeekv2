package iothub

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGenerateSASToken_FormatAndExpiry(t *testing.T) {
	host := "foo.azure-devices.net"
	deviceID := "meatgeek3"
	key := base64.StdEncoding.EncodeToString([]byte("secret-key-bytes"))

	before := time.Now()
	token, expiry, err := GenerateSASToken(host, deviceID, key, 1*time.Hour)
	after := time.Now()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(token, "SharedAccessSignature ") {
		t.Fatalf("token must start with `SharedAccessSignature `: %q", token)
	}

	body := strings.TrimPrefix(token, "SharedAccessSignature ")
	parsed, err := url.ParseQuery(body)
	if err != nil {
		t.Fatalf("token body is not a valid querystring: %v (body=%q)", err, body)
	}

	wantResource := fmt.Sprintf("%s/devices/%s", host, deviceID)
	if got := parsed.Get("sr"); got != wantResource {
		t.Errorf("decoded sr = %q, want %q", got, wantResource)
	}

	se := parsed.Get("se")
	if se == "" {
		t.Fatal("se (expiry) missing from token")
	}
	seUnix, err := strconv.ParseInt(se, 10, 64)
	if err != nil {
		t.Fatalf("se=%q is not a unix timestamp: %v", se, err)
	}
	minExpected := before.Add(1 * time.Hour).Unix()
	maxExpected := after.Add(1 * time.Hour).Unix()
	if seUnix < minExpected || seUnix > maxExpected+1 {
		t.Errorf("se=%d outside expected window [%d..%d]", seUnix, minExpected, maxExpected+1)
	}
	if expiry.Unix() != seUnix {
		t.Errorf("returned expiry %d does not match token se %d", expiry.Unix(), seUnix)
	}

	if parsed.Get("sig") == "" {
		t.Error("sig missing from token")
	}
	if parsed.Get("skn") != "" {
		t.Errorf("device-scoped SAS must omit skn; got %q", parsed.Get("skn"))
	}
}

func TestGenerateSASToken_ResourceURIEscaping(t *testing.T) {
	// The resource string is "<host>/devices/<deviceID>" — its '/'
	// characters MUST be percent-encoded on the wire.
	host := "foo.azure-devices.net"
	deviceID := "edge/device-1"
	key := base64.StdEncoding.EncodeToString([]byte("k"))

	token, _, err := GenerateSASToken(host, deviceID, key, time.Minute)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	body := strings.TrimPrefix(token, "SharedAccessSignature ")

	wantWire := "sr=foo.azure-devices.net%2Fdevices%2Fedge%2Fdevice-1"
	if !strings.Contains(body, wantWire) {
		t.Errorf("expected wire-level %q in token; got body=%q", wantWire, body)
	}
	parsed, _ := url.ParseQuery(body)
	if got := parsed.Get("sr"); got != "foo.azure-devices.net/devices/edge/device-1" {
		t.Errorf("decoded sr = %q", got)
	}
}

func TestGenerateSASToken_InvalidKey(t *testing.T) {
	if _, _, err := GenerateSASToken("h", "d", "not-base64-!@#$", time.Minute); err == nil {
		t.Fatal("expected error for non-base64 SharedAccessKey")
	}
}

func TestGenerateSASToken_NonPositiveTTL(t *testing.T) {
	key := base64.StdEncoding.EncodeToString([]byte("k"))
	if _, _, err := GenerateSASToken("h", "d", key, 0); err == nil {
		t.Fatal("expected error for zero TTL")
	}
	if _, _, err := GenerateSASToken("h", "d", key, -time.Second); err == nil {
		t.Fatal("expected error for negative TTL")
	}
}

func TestGenerateSASToken_DeterministicSignature(t *testing.T) {
	// Fixed inputs (pinned expiry) → byte-equal token. Uses the
	// package-private helper that lets us pin the expiry.
	host := "foo.azure-devices.net"
	deviceID := "meatgeek3"
	key := base64.StdEncoding.EncodeToString([]byte("secret"))

	tokA, _, err := generateSASTokenAt(host, deviceID, key, 1700000000)
	if err != nil {
		t.Fatal(err)
	}
	tokB, _, err := generateSASTokenAt(host, deviceID, key, 1700000000)
	if err != nil {
		t.Fatal(err)
	}
	if tokA != tokB {
		t.Errorf("expected deterministic token for fixed inputs:\n A=%s\n B=%s", tokA, tokB)
	}
}

// -- Client interface tests --
//
// These live in this file (instead of a separate client_test.go) so
// step #5 stays within the file list its tech-lead step.files declares.

// Compile-time assertions: both implementations satisfy Client.
var (
	_ Client = (*AzureClient)(nil)
	_ Client = (*MockClient)(nil)
)

func TestClientInterface_SatisfiedByBothImplementations(t *testing.T) {
	var c Client

	c = NewMockClient()
	if c == nil {
		t.Fatal("MockClient should satisfy Client")
	}

	azure, err := NewAzureClient("HostName=foo.azure-devices.net;DeviceId=d;SharedAccessKey=Zm9v")
	if err != nil {
		t.Fatalf("NewAzureClient: %v", err)
	}
	c = azure
	if c == nil {
		t.Fatal("AzureClient should satisfy Client")
	}
	if azure.DeviceID() != "d" {
		t.Errorf("DeviceID() = %q, want %q (must come from conn string, not the hard-coded `meatgeek3`)", azure.DeviceID(), "d")
	}
	if azure.HostName() != "foo.azure-devices.net" {
		t.Errorf("HostName() = %q", azure.HostName())
	}
	if err := azure.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}

func TestNewAzureClient_RejectsHubScopedString(t *testing.T) {
	hubOwner := "HostName=foo.azure-devices.net;SharedAccessKeyName=iothubowner;SharedAccessKey=Zm9v"
	_, err := NewAzureClient(hubOwner)
	if err == nil {
		t.Fatal("expected NewAzureClient to reject hub-scoped string")
	}
	if !strings.Contains(err.Error(), "device_connection_strings") {
		t.Errorf("error must name `device_connection_strings`: %v", err)
	}
}

func TestMockClient_RecordsMessageIDAndCorrelationProperties(t *testing.T) {
	m := NewMockClient()
	payload := []byte(`{"deviceId":"meatgeek3","grillTemp":225}`)
	props := map[string]string{
		MessageIDPropertyName:     "abc123-deterministic",
		CorrelationIDPropertyName: "corr-xyz",
		"customProp":              "should-also-be-recorded",
	}
	if err := m.PublishTelemetry(context.Background(), payload, props); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	calls := m.Calls()
	if len(calls) != 1 {
		t.Fatalf("want 1 recorded call, got %d", len(calls))
	}
	got := calls[0]

	if string(got.Payload) != string(payload) {
		t.Errorf("payload = %q, want %q", got.Payload, payload)
	}
	if got.Properties[MessageIDPropertyName] != "abc123-deterministic" {
		t.Errorf("messageId property = %q", got.Properties[MessageIDPropertyName])
	}
	if got.Properties[CorrelationIDPropertyName] != "corr-xyz" {
		t.Errorf("correlation.id property = %q", got.Properties[CorrelationIDPropertyName])
	}
	if got.Properties["customProp"] != "should-also-be-recorded" {
		t.Errorf("customProp not recorded: %q", got.Properties["customProp"])
	}

	// Defensive-copy contract: mutating the caller's slice/map after
	// the call must NOT corrupt the recorded snapshot.
	props[MessageIDPropertyName] = "mutated"
	payload[0] = 'X'
	if calls[0].Properties[MessageIDPropertyName] != "abc123-deterministic" {
		t.Error("recorded properties must be defensively copied (map)")
	}
	if calls[0].Payload[0] == 'X' {
		t.Error("recorded payload must be defensively copied (slice)")
	}
}

func TestMockClient_MultipleCallsAccumulate(t *testing.T) {
	m := NewMockClient()
	for i := 0; i < 3; i++ {
		if err := m.PublishTelemetry(context.Background(), []byte("p"), map[string]string{
			MessageIDPropertyName: fmt.Sprintf("id-%d", i),
		}); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	calls := m.Calls()
	if len(calls) != 3 {
		t.Fatalf("want 3 calls, got %d", len(calls))
	}
	for i, c := range calls {
		want := fmt.Sprintf("id-%d", i)
		if c.Properties[MessageIDPropertyName] != want {
			t.Errorf("call %d messageId = %q, want %q", i, c.Properties[MessageIDPropertyName], want)
		}
	}
}

func TestMockClient_CloseIsNoOp(t *testing.T) {
	m := NewMockClient()
	if err := m.Close(); err != nil {
		t.Errorf("Close = %v, want nil", err)
	}
}

func TestBuildPublishTopic(t *testing.T) {
	// Bare event topic when no properties.
	if got := buildPublishTopic("meatgeek3", nil); got != "devices/meatgeek3/messages/events/" {
		t.Errorf("bare topic = %q", got)
	}

	// Properties URL-encoded into the topic suffix.
	topic := buildPublishTopic("meatgeek3", map[string]string{
		MessageIDPropertyName:     "id-1",
		CorrelationIDPropertyName: "corr.with/special&chars",
	})
	if !strings.HasPrefix(topic, "devices/meatgeek3/messages/events/") {
		t.Errorf("topic prefix mismatch: %q", topic)
	}
	suffix := strings.TrimPrefix(topic, "devices/meatgeek3/messages/events/")
	vals, err := url.ParseQuery(suffix)
	if err != nil {
		t.Fatalf("topic suffix is not a valid querystring: %v (%q)", err, suffix)
	}
	if vals.Get(MessageIDPropertyName) != "id-1" {
		t.Errorf("messageId in topic = %q", vals.Get(MessageIDPropertyName))
	}
	if vals.Get(CorrelationIDPropertyName) != "corr.with/special&chars" {
		t.Errorf("correlation.id in topic = %q", vals.Get(CorrelationIDPropertyName))
	}
}

func TestCorrelationIDPropertyName_SingleRenameSite(t *testing.T) {
	// Ticket #6 will rename this constant. The test pins the current
	// value so a rename is intentional, not accidental.
	if CorrelationIDPropertyName != "correlation.id" {
		t.Errorf("CorrelationIDPropertyName = %q; ticket #5's brief stipulates `correlation.id` as the placeholder", CorrelationIDPropertyName)
	}
}
