package telemetry

import (
	"os"

	"go.opentelemetry.io/otel/attribute"
)

// The six standard custom-dimension keys carried on every pusher span.
//
// These mirror the cross-service correlation contract (MG-6): the same
// six keys are stamped by the API layer and the Functions layer so a
// single trace can be pivoted on any of them in Azure Monitor. Keep the
// key strings identical across services — they are the join columns.
const (
	DimDeviceID       = attribute.Key("device.id")
	DimCookID         = attribute.Key("cook.id")
	DimCorrelationID  = attribute.Key("correlation.id")
	DimProcessingPath = attribute.Key("processing.path")
	DimComponent      = attribute.Key("component")
	DimEnvironment    = attribute.Key("environment")
)

// StandardDimensionKeys is the canonical ordered list of the six custom
// dimension keys. Tests assert the helper emits exactly these.
var StandardDimensionKeys = []attribute.Key{
	DimDeviceID,
	DimCookID,
	DimCorrelationID,
	DimProcessingPath,
	DimComponent,
	DimEnvironment,
}

// componentName is the fixed component tag for this service. It is the
// same value the resource carries so span-level and resource-level
// component tags agree.
const componentName = "data-pusher"

// Dimensions holds the per-record values for the six standard custom
// dimensions. Component defaults to "data-pusher" and Environment to the
// ENVIRONMENT env var (or "development") when left empty, so callers only
// have to supply the record-specific fields (device/cook/correlation/path).
type Dimensions struct {
	DeviceID       string
	CookID         string
	CorrelationID  string
	ProcessingPath string
	Component      string
	Environment    string
}

// Attributes renders the six standard custom dimensions as an ordered
// slice of attribute.KeyValue — exactly six entries, one per key in
// StandardDimensionKeys, always present (empty string when unset) so the
// dimension set has a stable shape in Azure Monitor.
func (d Dimensions) Attributes() []attribute.KeyValue {
	component := d.Component
	if component == "" {
		component = componentName
	}
	environment := d.Environment
	if environment == "" {
		environment = resolveEnvironment()
	}
	return []attribute.KeyValue{
		DimDeviceID.String(d.DeviceID),
		DimCookID.String(d.CookID),
		DimCorrelationID.String(d.CorrelationID),
		DimProcessingPath.String(d.ProcessingPath),
		DimComponent.String(component),
		DimEnvironment.String(environment),
	}
}

// resolveEnvironment resolves the deployment environment tag from the
// ENVIRONMENT env var, defaulting to "development".
func resolveEnvironment() string {
	if v := os.Getenv("ENVIRONMENT"); v != "" {
		return v
	}
	return "development"
}
