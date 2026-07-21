package telemetry

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

// TraceParentKey is the W3C Trace Context header/property name carrying
// the trace id + span id + flags. It is stamped onto IoT Hub messages as
// a message property so the downstream Functions/API layers can continue
// the trace. Value form: "00-<32hex traceid>-<16hex spanid>-<2hex flags>".
const TraceParentKey = "traceparent"

// InjectTraceContext writes the active span's W3C trace context from ctx
// into props using the global TextMapPropagator (set to TraceContext in
// SetupTracing). It mutates props in place, adding at least a
// `traceparent` entry when ctx carries a recording/valid span. Existing
// entries in props (messageId, correlation.id) are preserved.
func InjectTraceContext(ctx context.Context, props map[string]string) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.MapCarrier(props))
}
