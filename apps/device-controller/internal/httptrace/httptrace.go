// Package httptrace wires W3C trace-context continuation onto the
// device-controller's inbound HTTP hop (MG-6).
//
// The device-controller serves smoker status through gobot's HTTP API
// (gobot.io/x/gobot/v2/api). gobot dispatches the get_status command through its
// own router, but its api.API.AddHandler middleware runs per-request BEFORE the
// router with access to the raw *http.Request — that is the only injection point
// where inbound request headers are visible. The data-pusher collector (the
// client of this hop) injects a `traceparent` header; this package extracts it
// and opens a server span parented to the upstream span, so the
// device-controller span continues the data-pusher trace instead of starting a
// detached root.
//
// otelhttp is not a project dependency, so extraction is done manually with the
// globally installed propagator (propagation.TraceContext, set by
// telemetry.Setup) rather than by wrapping the http.Handler with otelhttp.
package httptrace

import (
	"context"
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// Middleware returns a gobot API handler (see api.API.AddHandler) that continues
// an inbound W3C trace for every request. It opens and immediately ends a server
// span parented to the upstream context; gobot's command handlers read shared
// state rather than a request-scoped context, so there is no downstream ctx to
// thread the span into — the span's purpose is to anchor the continued trace at
// the device-controller boundary.
func Middleware(tracer trace.Tracer) func(http.ResponseWriter, *http.Request) {
	return func(_ http.ResponseWriter, r *http.Request) {
		_, span := StartSpanFromRequest(tracer, r)
		span.End()
	}
}

// StartSpanFromRequest extracts the W3C trace context carried on r's headers
// using the globally installed propagator and starts a server span parented to
// the extracted (possibly remote) span context. The returned context carries the
// new span; the caller owns ending it. Exposed for direct use and testing.
func StartSpanFromRequest(tracer trace.Tracer, r *http.Request) (context.Context, trace.Span) {
	ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
	return tracer.Start(
		ctx,
		"device-controller "+r.Method+" "+r.URL.Path,
		trace.WithSpanKind(trace.SpanKindServer),
	)
}
