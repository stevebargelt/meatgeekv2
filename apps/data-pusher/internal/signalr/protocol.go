package signalr

import (
	"bytes"
	"encoding/json"
	"time"
)

// SignalR JSON protocol v1 framing constant. Every message on the wire is
// terminated by a Record Separator byte.
const recordSeparator byte = 0x1e

// SignalR message-type discriminators (from the JSON protocol spec).
const (
	msgInvocation     = 1
	msgStreamItem     = 2
	msgCompletion     = 3
	msgStreamInvoke   = 4
	msgCancelInvoke   = 5
	msgPing           = 6
	msgClose          = 7
)

// handshakeRequest is the first frame the client sends after the WebSocket
// upgrade. The server responds with handshakeResponse on success or an
// error blob (also handshakeResponse-shaped) on failure.
type handshakeRequest struct {
	Protocol string `json:"protocol"`
	Version  int    `json:"version"`
}

type handshakeResponse struct {
	Error string `json:"error,omitempty"`
}

// signalRMessage is the lowest-common-denominator parse of a SignalR JSON
// frame: enough fields to dispatch by type. Concrete invocation payloads
// live in Arguments[0] and are unmarshalled into envelopeArgument by the
// dispatcher.
type signalRMessage struct {
	Type      int               `json:"type"`
	Target    string            `json:"target,omitempty"`
	Arguments []json.RawMessage `json:"arguments,omitempty"`
}

// envelopeArgument matches SignalREnvelopeBase from signalr-payloads.yaml.
// Payload is left as RawMessage so the dispatcher can branch on Type before
// unmarshalling the concrete shape.
type envelopeArgument struct {
	Type        string             `json:"type"`
	Timestamp   time.Time          `json:"timestamp"`
	MessageID   string             `json:"messageId"`
	DeviceID    string             `json:"deviceId,omitempty"`
	UserID      string             `json:"userId,omitempty"`
	CookID      *string            `json:"cookId,omitempty"`
	Correlation CorrelationContext `json:"correlation"`
	Payload     json.RawMessage    `json:"payload,omitempty"`
}

// negotiateResponse is the subset of the SignalR /negotiate POST response
// the pusher needs. availableTransports is intentionally ignored — the
// client supports WebSockets only.
type negotiateResponse struct {
	ConnectionID     string `json:"connectionId"`
	NegotiateVersion int    `json:"negotiateVersion"`
}

// splitFrames splits a buffer at the SignalR record separator and returns
// the list of complete frames plus any incomplete tail.
func splitFrames(buf []byte) ([][]byte, []byte) {
	var frames [][]byte
	rest := buf
	for {
		idx := bytes.IndexByte(rest, recordSeparator)
		if idx < 0 {
			return frames, rest
		}
		// Copy so callers may retain the slice after we reuse the buffer.
		frame := make([]byte, idx)
		copy(frame, rest[:idx])
		frames = append(frames, frame)
		rest = rest[idx+1:]
	}
}

// frameWithSeparator returns a fresh slice with the record separator
// appended, ready to be written to the wire.
func frameWithSeparator(payload []byte) []byte {
	out := make([]byte, 0, len(payload)+1)
	out = append(out, payload...)
	out = append(out, recordSeparator)
	return out
}
