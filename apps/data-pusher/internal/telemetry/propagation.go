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

// ExtractTraceparent renders the active span's W3C `traceparent` string from
// ctx using the global propagator. It returns "" when ctx carries no valid /
// recording span.
//
// This is the persist half of the per-reading trace-continuity contract (F3):
// the enqueuer captures the reading span's traceparent with this and writes it
// into the durable queue record, so the publish span can continue the SAME
// trace even after a process restart/recover between enqueue and publish.
func ExtractTraceparent(ctx context.Context) string {
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return carrier[TraceParentKey]
}

// ContextFromTraceparent returns a context derived from parent that carries the
// remote span context decoded from a stored W3C `traceparent` string. When
// traceparent is empty or malformed, parent is returned unchanged (the caller's
// span then starts from parent, not from a detached root).
//
// This is the recover half of the F3 contract: on DEQUEUE the publisher passes
// the record's persisted traceparent here and starts its publish span from the
// returned context, so the publish belongs to the same per-reading trace that
// the enqueuer opened — surviving process restarts because the linkage rode on
// disk, not in memory.
func ContextFromTraceparent(parent context.Context, traceparent string) context.Context {
	if traceparent == "" {
		return parent
	}
	carrier := propagation.MapCarrier{TraceParentKey: traceparent}
	return otel.GetTextMapPropagator().Extract(parent, carrier)
}
