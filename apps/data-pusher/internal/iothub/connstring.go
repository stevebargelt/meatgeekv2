package iothub

import (
	"fmt"
	"strings"
)

// DeviceConnectionString is a parsed per-device Azure IoT Hub
// connection string of the form
//
//	HostName=<host>;DeviceId=<id>;SharedAccessKey=<key>
//
// The hub-scoped owner string (no DeviceId; SharedAccessKeyName=iothubowner)
// is rejected with an actionable error — the pusher must run with a
// per-device credential.
type DeviceConnectionString struct {
	HostName        string
	DeviceID        string
	SharedAccessKey string
}

// ParseDeviceConnectionString parses a per-device IoT Hub connection
// string. It FAILS FAST on hub-scoped strings, naming the Terraform
// output (`device_connection_strings`) where per-device strings live.
func ParseDeviceConnectionString(connStr string) (*DeviceConnectionString, error) {
	if strings.TrimSpace(connStr) == "" {
		return nil, fmt.Errorf(
			"iothub: connection string is empty (expected per-device " +
				"string from the Terraform output `device_connection_strings`)")
	}

	parsed := &DeviceConnectionString{}
	for _, part := range strings.Split(connStr, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		key := strings.TrimSpace(kv[0])
		val := strings.TrimSpace(kv[1])
		switch key {
		case "HostName":
			parsed.HostName = val
		case "DeviceId":
			parsed.DeviceID = val
		case "SharedAccessKey":
			parsed.SharedAccessKey = val
		}
	}

	if parsed.HostName == "" {
		return nil, fmt.Errorf("iothub: connection string missing HostName segment")
	}
	if parsed.DeviceID == "" {
		return nil, fmt.Errorf(
			"iothub: connection string lacks a DeviceId segment — this " +
				"looks like a hub-scoped (owner) credential. The data-pusher " +
				"requires a per-device connection string. Source it from the " +
				"Terraform output `device_connection_strings` " +
				"(apps/infrastructure/outputs.tf).")
	}
	if parsed.SharedAccessKey == "" {
		return nil, fmt.Errorf("iothub: connection string missing SharedAccessKey segment")
	}
	return parsed, nil
}
