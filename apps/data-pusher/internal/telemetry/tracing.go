package telemetry

import (
	"context"
	"fmt"
	"os"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

// EnvOTLPEndpoint is the standard OpenTelemetry environment variable naming the
// OTLP receiver the span exporter targets. In the MeatGeek F2 topology this is
// an OpenTelemetry Collector (which in turn fronts Azure Monitor) — NOT the App
// Insights ingestion endpoint, which is not an OTLP receiver.
const EnvOTLPEndpoint = "OTEL_EXPORTER_OTLP_ENDPOINT"

// SetupTracing initializes OpenTelemetry tracing for the pusher.
//
// Exporter selection is driven ONLY by the standard OTEL_EXPORTER_OTLP_ENDPOINT
// environment variable (an OTLP collector endpoint):
//
//   - unset / empty -> a no-op exporter (dev / offline mode); no network, no panic.
//   - set           -> a real OTLP/HTTP span exporter built by newSpanExporter.
//
// The exporter endpoint comes SOLELY from OTEL_EXPORTER_OTLP_ENDPOINT. No
// connection string (App Insights or otherwise) is ever read or parsed — the
// App Insights connection string lives only on the collector, which fronts
// Azure Monitor; the edge services push OTLP to the collector and never touch
// it. The App Insights ingestion endpoint is not an OTLP receiver, so steering
// the exporter at it would be wrong.
//
// The concrete backend is swappable: newSpanExporter is a package var so the
// backend can be replaced (e.g. an Azure Monitor Go exporter once it is GA)
// without touching this function or its callers.
//
// The global TextMapPropagator is set to W3C Trace Context so the
// traceparent injected onto IoT Hub messages interoperates with the
// downstream Functions/API layers. Sampling is AlwaysSample. The returned
// shutdown func is always non-nil.
func SetupTracing(ctx context.Context) (func(), error) {
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("meatgeek-pusher"),
			semconv.ServiceVersion("1.0.0"),
			semconv.ServiceInstanceID("meatgeek-pusher-1"),
			// Resource-level copies of the environment-invariant custom
			// dimensions so every span carries them even before the
			// per-record Dimensions helper runs.
			DimComponent.String(componentName),
			DimEnvironment.String(resolveEnvironment()),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	var exporter trace.SpanExporter
	if strings.TrimSpace(os.Getenv(EnvOTLPEndpoint)) != "" {
		exporter, err = newSpanExporter(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to create span exporter: %w", err)
		}
	} else {
		// Dev / offline mode: no OTLP collector configured, swallow spans
		// locally and never dial out.
		exporter = &noOpExporter{}
	}

	tp := trace.NewTracerProvider(
		trace.WithBatcher(exporter),
		trace.WithResource(res),
		trace.WithSampler(trace.AlwaysSample()),
	)

	otel.SetTracerProvider(tp)
	// W3C Trace Context is the wire format for the traceparent property we
	// inject onto IoT Hub messages; setting it globally makes
	// otel.GetTextMapPropagator().Inject emit `traceparent`.
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return func() {
		if err := tp.Shutdown(context.Background()); err != nil {
			fmt.Printf("Error shutting down tracer provider: %v\n", err)
		}
	}, nil
}

// newSpanExporter builds the concrete backing exporter, an OTLP/HTTP exporter
// aimed at the OpenTelemetry Collector. otlptracehttp.New reads the endpoint
// (and the other standard OTLP settings) from the OTEL_EXPORTER_OTLP_ENDPOINT
// environment variable itself; no endpoint is passed explicitly, so the target
// comes solely from the environment. Swappable by design: replace this var to
// swap the backend without touching SetupTracing.
//
// otlptracehttp.New does NOT dial on construction (the transport connects
// lazily on first export), so this returns a live exporter with no network
// round-trip — safe to construct offline / in tests.
var newSpanExporter = func(ctx context.Context) (trace.SpanExporter, error) {
	return otlptracehttp.New(ctx)
}

// noOpExporter is a no-op SpanExporter for dev / offline mode: spans are
// dropped, nothing is sent anywhere, and Shutdown never errors.
type noOpExporter struct{}

func (e *noOpExporter) ExportSpans(ctx context.Context, spans []trace.ReadOnlySpan) error {
	return nil
}

func (e *noOpExporter) Shutdown(ctx context.Context) error {
	return nil
}
