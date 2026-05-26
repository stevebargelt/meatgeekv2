package signalr

import "time"

// EventType is the SignalR message type discriminator the pusher cares about.
//
// Mirrors the SignalRMessageType enum at
// libs/api-specs/spec/components/schemas/signalr-payloads.yaml — only the
// cook-lifecycle members are surfaced here. Other types (temperature_update,
// device_online, alert_triggered, system_notification) are silently dropped
// by the dispatcher because the pusher has no business acting on them.
type EventType string

const (
	EventTypeCookStarted EventType = "cook_started"
	EventTypeCookStopped EventType = "cook_stopped"
	EventTypeCookPaused  EventType = "cook_paused"
	EventTypeCookResumed EventType = "cook_resumed"
)

// CorrelationContext mirrors signalr-payloads.yaml#/CorrelationContext.
// `id` is propagated end-to-end and is the message property the pusher
// later stamps on outbound IoT Hub messages (placeholder name finalized in
// ticket #6).
type CorrelationContext struct {
	ID         string `json:"id"`
	ParentID   string `json:"parentId,omitempty"`
	TraceFlags string `json:"traceFlags,omitempty"`
}

// Cook is a minimal projection of cook.yaml#/Cook covering the fields the
// pusher inspects (the full schema has many more — we only need to know the
// cook id when the envelope-level cookId is empty).
type Cook struct {
	ID       string `json:"id"`
	UserID   string `json:"userId,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	Name     string `json:"name,omitempty"`
	Status   string `json:"status,omitempty"`
}

// Event is the typed value emitted on Client.Events(). Mirrors the union of
// the cook-lifecycle envelopes from signalr-payloads.yaml with the fields
// the pusher needs to act on (the cooksession.Store updates, the queue-
// runner's correlation.id stamping).
type Event struct {
	Type        EventType
	Timestamp   time.Time
	MessageID   string
	DeviceID    string
	// CookID is the active-cook discriminator carried by the envelope. It is
	// always nil for EventTypeCookStopped (the pusher uses that to clear the
	// cooksession.Store entry) and is populated for the other lifecycle
	// events when the producer stamps it.
	CookID      *string
	Correlation CorrelationContext
	// Cook is the parsed payload body, if the producer sent one and it
	// parsed cleanly. nil if the payload was absent or malformed.
	Cook *Cook
}
