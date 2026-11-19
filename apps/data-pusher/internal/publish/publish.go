// Package publish holds the builders that turn one reading into the bytes and
// IoT Hub message properties the pusher publishes. They live outside
// `package main` so every sender of readings — the data-pusher on the Pi and
// the simdevice command in dev — builds its messages through the same code,
// and a message from one is indistinguishable from a message from the other.
package publish

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/telemetry"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/wire"
)

// ReadingPayload maps a V1 status to the V2 TemperatureReading and renders
// the JSON bytes that ride as the IoT Hub message body. cookID may be nil
// (serialized as an absent `cookId`).
func ReadingPayload(status wire.V1Status, timestamp time.Time, cookID *string) ([]byte, error) {
	reading := wire.MapV1ToTemperatureReading(status, timestamp, cookID)
	b, err := json.Marshal(reading)
	if err != nil {
		return nil, fmt.Errorf("publish: marshal TemperatureReading: %w", err)
	}
	return b, nil
}

// MessageID mints the deterministic IoT Hub message id for one reading. See
// wire.MintMessageId for why it is deterministic.
func MessageID(deviceID string, timestamp time.Time, seq uint64) string {
	return wire.MintMessageId(deviceID, timestamp, seq)
}

// Properties assembles the IoT Hub message properties for one message:
//
//   - messageId: the deterministic id from MessageID.
//   - $.ct / $.ce: the IoT Hub system properties content type
//     (application/json) and content encoding (utf-8). IoT Hub stores a
//     routed body as JSON only when BOTH are set; without them the Cosmos
//     route writes the body as a base64 string, which the API skips (MG-68).
//   - correlation.id: only when correlation is non-empty.
//   - traceparent (and any tracestate): injected from the active span in ctx
//     so downstream layers continue the distributed trace. Absent when ctx
//     carries no valid span.
func Properties(ctx context.Context, messageID, correlation string) map[string]string {
	props := map[string]string{
		iothub.MessageIDPropertyName:       messageID,
		iothub.ContentTypePropertyName:     iothub.ContentTypeJSON,
		iothub.ContentEncodingPropertyName: iothub.ContentEncodingUTF8,
	}
	if correlation != "" {
		props[iothub.CorrelationIDPropertyName] = correlation
	}
	telemetry.InjectTraceContext(ctx, props)
	return props
}
