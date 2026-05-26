package telemetry

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

// SetupTracing initializes OpenTelemetry tracing with Azure Monitor
func SetupTracing(ctx context.Context, appInsightsConnStr string) (func(), error) {
	// Create resource
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("meatgeek-pusher"),
			semconv.ServiceVersion("1.0.0"),
			semconv.ServiceInstanceID("meatgeek-pusher-1"),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	var exporter trace.SpanExporter

	if appInsightsConnStr != "" {
		// TODO: Implement Azure Monitor exporter
		// For now, use OTLP HTTP exporter as placeholder
		exporter, err = otlptracehttp.New(ctx,
			otlptracehttp.WithEndpoint("https://localhost:4318"), // Placeholder
			otlptracehttp.WithInsecure(),
		)
		if err != nil {
			return nil, fmt.Errorf("failed to create Azure Monitor exporter: %w", err)
		}
	} else {
		// Development mode - no exporter (traces are not sent anywhere)
		exporter = &noOpExporter{}
	}

	// Create trace provider
	tp := trace.NewTracerProvider(
		trace.WithBatcher(exporter),
		trace.WithResource(res),
		trace.WithSampler(trace.AlwaysSample()), // Sample all traces in development
	)

	// Set global provider
	otel.SetTracerProvider(tp)

	// Return shutdown function
	return func() {
		if err := tp.Shutdown(context.Background()); err != nil {
			fmt.Printf("Error shutting down tracer provider: %v\n", err)
		}
	}, nil
}

// noOpExporter is a no-op exporter for development
type noOpExporter struct{}

func (e *noOpExporter) ExportSpans(ctx context.Context, spans []trace.ReadOnlySpan) error {
	// No-op: don't send traces anywhere in development mode
	return nil
}

func (e *noOpExporter) Shutdown(ctx context.Context) error {
	return nil
}