package telemetry

import (
	"context"
	"fmt"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

// SetupTracing initializes OpenTelemetry tracing for the pusher.
//
// Exporter selection is driven ONLY by appInsightsConnStr (sourced from
// APPLICATIONINSIGHTS_CONNECTION_STRING — never a literal):
//
//   - empty  -> a no-op exporter (dev / offline mode); no network, no panic.
//   - set    -> a real span exporter built by newSpanExporter.
//
// The concrete backend is swappable: the Azure Monitor Go exporter is not
// a GA first-class module, so we target an OTLP endpoint (an OpenTelemetry
// Collector or the App Insights ingestion endpoint parsed out of the
// connection string). newSpanExporter is a package var so the backend can
// be replaced without touching this function or its callers.
//
// The global TextMapPropagator is set to W3C Trace Context so the
// traceparent injected onto IoT Hub messages interoperates with the
// downstream Functions/API layers. Sampling is AlwaysSample. The returned
// shutdown func is always non-nil.
func SetupTracing(ctx context.Context, appInsightsConnStr string) (func(), error) {
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
	if strings.TrimSpace(appInsightsConnStr) != "" {
		exporter, err = newSpanExporter(ctx, appInsightsConnStr)
		if err != nil {
			return nil, fmt.Errorf("failed to create span exporter: %w", err)
		}
	} else {
		// Dev / offline mode: swallow spans locally, never dial out.
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

// newSpanExporter builds the concrete backing exporter from an App
// Insights connection string. Swappable by design: today it constructs an
// OTLP/HTTP exporter aimed at the endpoint parsed from the connection
// string (an OTel Collector or the ingestion endpoint), which is the
// pragmatic stand-in until the Azure Monitor Go exporter is GA. Replace
// this var to swap the backend without touching SetupTracing.
//
// otlptracehttp.New does NOT dial on construction (the transport connects
// lazily on first export), so this returns a live exporter with no network
// round-trip — safe to construct offline / in tests.
var newSpanExporter = func(ctx context.Context, appInsightsConnStr string) (trace.SpanExporter, error) {
	opts := []otlptracehttp.Option{}
	if endpoint := ingestionEndpoint(appInsightsConnStr); endpoint != "" {
		opts = append(opts, otlptracehttp.WithEndpointURL(endpoint))
	}
	return otlptracehttp.New(ctx, opts...)
}

// ingestionEndpoint pulls the IngestionEndpoint value out of a standard
// App Insights connection string (semicolon-separated key=value pairs,
// e.g. "InstrumentationKey=...;IngestionEndpoint=https://...;..."). Returns
// "" when absent, in which case the exporter falls back to the OTLP
// default endpoint (or the OTEL_EXPORTER_OTLP_ENDPOINT env override).
func ingestionEndpoint(connStr string) string {
	for _, part := range strings.Split(connStr, ";") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(kv[0]), "IngestionEndpoint") {
			return strings.TrimSpace(kv[1])
		}
	}
	return ""
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
