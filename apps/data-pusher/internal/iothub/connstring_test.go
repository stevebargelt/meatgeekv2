package iothub

import (
	"strings"
	"testing"
)

func TestParseDeviceConnectionString_HubScopedRejected(t *testing.T) {
	hubOwner := "HostName=foo.azure-devices.net;SharedAccessKeyName=iothubowner;SharedAccessKey=Zm9vYmFy"
	_, err := ParseDeviceConnectionString(hubOwner)
	if err == nil {
		t.Fatal("expected hub-scoped (owner) string to be rejected")
	}
	if !strings.Contains(err.Error(), "device_connection_strings") {
		t.Errorf("error must name the Terraform output `device_connection_strings`; got: %v", err)
	}
	if !strings.Contains(err.Error(), "DeviceId") {
		t.Errorf("error should mention the missing DeviceId segment; got: %v", err)
	}
}

func TestParseDeviceConnectionString_WellFormed(t *testing.T) {
	cs := "HostName=foo.azure-devices.net;DeviceId=meatgeek3;SharedAccessKey=Zm9vYmFy"
	parsed, err := ParseDeviceConnectionString(cs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if parsed.HostName != "foo.azure-devices.net" {
		t.Errorf("HostName = %q, want %q", parsed.HostName, "foo.azure-devices.net")
	}
	if parsed.DeviceID != "meatgeek3" {
		t.Errorf("DeviceID = %q, want %q", parsed.DeviceID, "meatgeek3")
	}
	if parsed.SharedAccessKey != "Zm9vYmFy" {
		t.Errorf("SharedAccessKey = %q, want %q", parsed.SharedAccessKey, "Zm9vYmFy")
	}
}

func TestParseDeviceConnectionString_FieldOrderInsensitive(t *testing.T) {
	cs := "SharedAccessKey=Zm9vYmFy;DeviceId=meatgeek3;HostName=foo.azure-devices.net"
	parsed, err := ParseDeviceConnectionString(cs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if parsed.DeviceID != "meatgeek3" || parsed.HostName != "foo.azure-devices.net" {
		t.Errorf("field-order-insensitive parse failed: %+v", parsed)
	}
}

func TestParseDeviceConnectionString_Empty(t *testing.T) {
	if _, err := ParseDeviceConnectionString(""); err == nil {
		t.Fatal("expected empty connection string to be rejected")
	}
	if _, err := ParseDeviceConnectionString("   "); err == nil {
		t.Fatal("expected whitespace-only connection string to be rejected")
	}
}

func TestParseDeviceConnectionString_MissingHostName(t *testing.T) {
	_, err := ParseDeviceConnectionString("DeviceId=foo;SharedAccessKey=Zm9vYmFy")
	if err == nil {
		t.Fatal("expected missing HostName to be rejected")
	}
	if !strings.Contains(err.Error(), "HostName") {
		t.Errorf("error should mention HostName; got: %v", err)
	}
}

func TestParseDeviceConnectionString_MissingKey(t *testing.T) {
	_, err := ParseDeviceConnectionString("HostName=foo;DeviceId=bar")
	if err == nil {
		t.Fatal("expected missing SharedAccessKey to be rejected")
	}
	if !strings.Contains(err.Error(), "SharedAccessKey") {
		t.Errorf("error should mention SharedAccessKey; got: %v", err)
	}
}

// TestParseDeviceConnectionString_ErrorsNeverEchoInput guards that no parse
// error carries the input or its key: callers (data-pusher, simdevice) print
// these errors, and a credential must never reach a log or terminal.
func TestParseDeviceConnectionString_ErrorsNeverEchoInput(t *testing.T) {
	const key = "ZmFrZS1rZXktZG8tbm90LXVzZS0xMjM0NTY3ODkw"
	for _, in := range []string{
		"SharedAccessKey=" + key,
		"DeviceId=d;SharedAccessKey=" + key,
		"HostName=h;SharedAccessKey=" + key,
		"HostName=h;SharedAccessKeyName=iothubowner;SharedAccessKey=" + key,
		"HostName=h;DeviceId=d;SharedAccessKey=",
		key,
		"  ",
	} {
		_, err := ParseDeviceConnectionString(in)
		if err == nil {
			t.Errorf("expected %q to be rejected", in)
			continue
		}
		if strings.Contains(err.Error(), key) {
			t.Errorf("parse error echoes the key: %v", err)
		}
		if strings.TrimSpace(in) != "" && strings.Contains(err.Error(), in) {
			t.Errorf("parse error echoes the input: %v", err)
		}
	}
}
