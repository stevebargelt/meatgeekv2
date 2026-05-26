// Package wire defines the V2 telemetry / SignalR wire types that the
// data-pusher exchanges with the cloud side, plus the V1->V2 mappers that
// translate the device-controller's local-HTTP JSON (apps/device-controller/
// main.go:254-276) into those shapes.
//
// Source of truth for these structs is libs/api-specs/spec/components/schemas/
// {temperature,device,signalr-payloads}.yaml. They are hand-written here
// rather than codegen'd because the pusher only needs a small subset and
// owns the V1->V2 translation seam end-to-end.
package wire

import (
	"encoding/json"
	"time"
)

// V1Status mirrors the JSON the device-controller serves at
// GET /api/robots/MeatGeekBot/commands/get_status. The shape lives in
// apps/device-controller/main.go's Status struct; the NaN-aware MarshalJSON
// on Temps means GrillTemp et al. arrive as `null` from the wire (not NaN),
// so the V1 unwrap uses *float64 to model both the "missing" and the
// "explicit 0.0 unplugged" cases.
type V1Status struct {
	ID          string    `json:"id"`
	TTL         int       `json:"ttl"`
	SmokerID    string    `json:"smokerid"`
	Type        string    `json:"type"`
	AugerOn     bool      `json:"augerOn"`
	BlowerOn    bool      `json:"blowerOn"`
	IgniterOn   bool      `json:"igniterOn"`
	Temps       V1Temps   `json:"temps"`
	FireHealthy bool      `json:"fireHealthy"`
	Mode        string    `json:"mode"`
	SetPoint    int       `json:"setPoint"`
	ModeTime    time.Time `json:"modeTime"`
	CurrentTime time.Time `json:"currentTime"`
}

// V1Temps mirrors the device-controller's Temps struct. The controller
// emits null for NaN/Inf via its custom MarshalJSON, so we accept pointers
// here to distinguish "absent" from a real zero reading.
type V1Temps struct {
	GrillTemp  *float64 `json:"grillTemp"`
	Probe1Temp *float64 `json:"probe1Temp"`
	Probe2Temp *float64 `json:"probe2Temp"`
	Probe3Temp *float64 `json:"probe3Temp"`
	Probe4Temp *float64 `json:"probe4Temp"`
}

// TemperatureReading mirrors libs/api-specs/spec/components/schemas/
// temperature.yaml#/TemperatureReading. Nullable probes and cookId use
// pointer + omitempty so a nil cookId serializes as absent (the spec's
// nullable behavior — the bare-getCurrent handler returns the object
// directly without wrapping).
type TemperatureReading struct {
	DeviceID   string    `json:"deviceId"`
	Timestamp  time.Time `json:"timestamp"`
	CookID     *string   `json:"cookId,omitempty"`
	GrillTemp  *float64  `json:"grillTemp,omitempty"`
	Probe1Temp *float64  `json:"probe1Temp,omitempty"`
	Probe2Temp *float64  `json:"probe2Temp,omitempty"`
	Probe3Temp *float64  `json:"probe3Temp,omitempty"`
	Probe4Temp *float64  `json:"probe4Temp,omitempty"`
}

// V2DeviceStatus mirrors device.yaml#/DeviceStatus — the hardware
// controller status snapshot (auger/blower/ignition + sensor readings).
type V2DeviceStatus struct {
	DeviceID     string         `json:"deviceId"`
	Timestamp    time.Time      `json:"timestamp"`
	AugerOn      bool           `json:"augerOn"`
	BlowerOn     bool           `json:"blowerOn"`
	IgniterOn    bool           `json:"igniterOn"`
	FireHealthy  bool           `json:"fireHealthy"`
	Mode         string         `json:"mode"`
	SetPoint     float64        `json:"setPoint"`
	CurrentTemps V2CurrentTemps `json:"currentTemps"`
	SystemHealth V2SystemHealth `json:"systemHealth"`
}

// V2CurrentTemps mirrors DeviceStatus.currentTemps. `grill` is required
// per the spec; the probe fields are optional.
type V2CurrentTemps struct {
	Grill  float64  `json:"grill"`
	Probe1 *float64 `json:"probe1,omitempty"`
	Probe2 *float64 `json:"probe2,omitempty"`
	Probe3 *float64 `json:"probe3,omitempty"`
	Probe4 *float64 `json:"probe4,omitempty"`
}

// V2SystemHealth mirrors DeviceStatus.systemHealth. The pusher does not
// have first-class host metrics yet, so the integration step will populate
// this with conservative defaults; the type is defined here so the
// downstream wire shape is locked.
type V2SystemHealth struct {
	CPUUsage      float64 `json:"cpuUsage"`
	MemoryUsage   float64 `json:"memoryUsage"`
	DiskUsage     float64 `json:"diskUsage"`
	NetworkStatus string  `json:"networkStatus"`
}

// DeviceTelemetryBatch is the optional batch envelope used when the pusher
// wants to ship multiple readings + a status snapshot in a single IoT Hub
// message. The current implementation emits TemperatureReading directly;
// this is reserved for ticket #6 / future batching needs.
type DeviceTelemetryBatch struct {
	DeviceID   string               `json:"deviceId"`
	BatchID    string               `json:"batchId"`
	Timestamp  time.Time            `json:"timestamp"`
	CookID     *string              `json:"cookId,omitempty"`
	Readings   []TemperatureReading `json:"readings"`
	Status     *V2DeviceStatus      `json:"status,omitempty"`
}

// CorrelationContext mirrors signalr-payloads.yaml#/CorrelationContext.
// `ID` is the only required field; it rides end-to-end (HTTP X-Request-ID
// -> SignalR payload -> device IoT message property `correlation.id`).
type CorrelationContext struct {
	ID         string `json:"id"`
	ParentID   string `json:"parentId,omitempty"`
	TraceFlags string `json:"traceFlags,omitempty"`
}

// SignalRMessageType is the discriminator value enum for SignalR envelopes.
type SignalRMessageType string

const (
	SignalRTemperatureUpdate  SignalRMessageType = "temperature_update"
	SignalRCookStarted        SignalRMessageType = "cook_started"
	SignalRCookStopped        SignalRMessageType = "cook_stopped"
	SignalRCookPaused         SignalRMessageType = "cook_paused"
	SignalRCookResumed        SignalRMessageType = "cook_resumed"
	SignalRDeviceOnline       SignalRMessageType = "device_online"
	SignalRDeviceOffline      SignalRMessageType = "device_offline"
	SignalRAlertTriggered     SignalRMessageType = "alert_triggered"
	SignalRSystemNotification SignalRMessageType = "system_notification"
)

// SignalREnvelopeBase mirrors signalr-payloads.yaml#/SignalREnvelopeBase.
// The Payload field is left as json.RawMessage so the consumer (the
// signalr package in step 4) can branch on Type and unmarshal the typed
// payload only for the message kinds the pusher cares about.
type SignalREnvelopeBase struct {
	Type        SignalRMessageType `json:"type"`
	Timestamp   time.Time          `json:"timestamp"`
	MessageID   string             `json:"messageId"`
	DeviceID    string             `json:"deviceId,omitempty"`
	UserID      string             `json:"userId,omitempty"`
	CookID      string             `json:"cookId,omitempty"`
	Correlation CorrelationContext `json:"correlation"`
	Payload     json.RawMessage    `json:"payload"`
}

// CookStartedMessage is the typed envelope for type=cook_started. Payload
// is a Cook resource per cook.yaml — we keep it as RawMessage here and
// only surface the fields the pusher actually consumes (cookId via the
// envelope's CookID field).
type CookStartedMessage struct {
	SignalREnvelopeBase
}

// CookStoppedMessage is the typed envelope for type=cook_stopped.
type CookStoppedMessage struct {
	SignalREnvelopeBase
}
