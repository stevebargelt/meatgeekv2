package iothub

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

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

	azure, err := NewX509Client("foo.azure-devices.net", "d", deviceCert(t, "d"))
	if err != nil {
		t.Fatalf("NewX509Client: %v", err)
	}
	c = azure
	if c == nil {
		t.Fatal("AzureClient should satisfy Client")
	}
	if azure.DeviceID() != "d" {
		t.Errorf("DeviceID() = %q, want %q (must be the device's own id, not the hard-coded `meatgeek3`)", azure.DeviceID(), "d")
	}
	if azure.HostName() != "foo.azure-devices.net" {
		t.Errorf("HostName() = %q", azure.HostName())
	}
	if err := azure.Close(); err != nil {
		t.Errorf("Close: %v", err)
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
