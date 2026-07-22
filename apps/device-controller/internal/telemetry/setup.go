// Package telemetry wires the OpenTelemetry Go trace SDK for the MeatGeek
// device controller.
//
// NewRelic instrumentation was removed in ticket #4; this package re-adds
// observability at the same main.go init site (MG-6). The concrete backend is
// OTLP/HTTP behind the OTel SpanExporter interface, aimed at an OpenTelemetry
// Collector named by the standard OTEL_EXPORTER_OTLP_ENDPOINT environment
// variable (the collector in turn fronts Azure Monitor — F2). No App Insights
// connection string is ever parsed to derive the endpoint: the App Insights
// ingestion endpoint is not an OTLP receiver. Swap newSpanExporter for the
// Azure Monitor Go exporter once it ships GA.
//
// The controller must run fully offline (e.g. a Raspberry Pi with no backend
// reachable): an unset/empty OTEL_EXPORTER_OTLP_ENDPOINT selects a no-op
// exporter and Setup never panics.
package telemetry

import (
	"context"
	"fmt"
	"os"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Standard MeatGeek custom dimensions carried on every span via the resource.
//
// These six keys mirror the cross-service correlation contract (MG-6): the
// data-pusher, Functions, and API layers stamp the SAME six keys so a single
// trace can be pivoted on any of them in Azure Monitor. Keep the key strings
// identical across services — they are the join columns.
const (
	attrServiceName    = "service.name"
	attrDeviceID       = "device.id"
	attrCookID         = "cook.id"
	attrCorrelationID  = "correlation.id"
	attrProcessingPath = "processing.path"
	attrComponent      = "component"
	attrEnvironment    = "environment"

	serviceName   = "device-controller"
	componentName = "device"

	// processingPath is this service's fixed processing.path dimension value.
	processingPath = "device"

	// unsetDimension is the placeholder for a standard dimension that has no
	// live value at the device level (cook.id / correlation.id). The key is
	// still emitted so the six-dimension set has a stable shape in Azure
	// Monitor, matching the other services.
	unsetDimension = "none"
)

// Environment variables read by ConfigFromEnv.
//
// OTEL_EXPORTER_OTLP_ENDPOINT is the standard OpenTelemetry variable naming the
// OTLP collector the span exporter targets; an unset/empty value selects the
// no-op exporter (offline path). ENVIRONMENT populates the environment custom
// dimension.
const (
	EnvOTLPEndpoint = "OTEL_EXPORTER_OTLP_ENDPOINT"
	EnvEnvironment  = "ENVIRONMENT"
)

// ShutdownFunc flushes buffered spans and releases telemetry resources. It is
// safe to defer and safe to call with a context that carries a timeout.
type ShutdownFunc func(context.Context) error

// Config holds the telemetry wiring inputs. DeviceID comes from the
// SmokerStatus (SmokerID); the remaining values are sourced from the process
// environment.
type Config struct {
	// DeviceID populates the device.id custom dimension (SmokerStatus.SmokerID).
	DeviceID string
	// Environment populates the environment custom dimension (ENVIRONMENT).
	Environment string
}

// ConfigFromEnv builds a Config from the environment, using deviceID for the
// device.id dimension.
func ConfigFromEnv(deviceID string) Config {
	return Config{
		DeviceID:    deviceID,
		Environment: os.Getenv(EnvEnvironment),
	}
}

// Setup builds the trace TracerProvider, installs it as the global provider,
// installs the W3C Trace Context propagator globally, and returns a shutdown
// func. It always samples (AlwaysSample) and attaches a resource carrying the
// standard MeatGeek custom dimensions.
//
// With OTEL_EXPORTER_OTLP_ENDPOINT unset/empty the provider uses a no-op
// exporter so the controller runs offline without an OTLP collector reachable
// and never panics. The returned ShutdownFunc always flushes and stops the
// provider and is safe to defer.
func Setup(ctx context.Context, cfg Config) (ShutdownFunc, error) {
	tp, err := newTracerProvider(ctx, cfg)
	if err != nil {
		return nil, err
	}
	otel.SetTracerProvider(tp)
	// W3C Trace Context is the wire format shared across the MeatGeek services;
	// setting it globally makes otel.GetTextMapPropagator().Inject emit
	// `traceparent` so a controller-originated trace continues downstream.
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return tp.Shutdown, nil
}

// newTracerProvider assembles the resource, exporter, and always-on sampler
// without installing the provider globally. Exposed (unexported) so tests can
// inspect the constructed provider directly.
func newTracerProvider(ctx context.Context, cfg Config) (*sdktrace.TracerProvider, error) {
	exporter, err := newSpanExporter(ctx)
	if err != nil {
		return nil, fmt.Errorf("telemetry: building span exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(newResource(cfg)),
	)
	return tp, nil
}

// newResource builds the OTel resource carrying the six standard custom
// dimensions. It is schemaless to keep the attribute set predictable (no
// merge with default detectors) and never errors.
//
// cook.id and correlation.id have no live value at the device level, so they
// default to "none" — present-but-empty — so the six-key dimension set stays
// uniform with the other services. processing.path is fixed to "device".
func newResource(cfg Config) *resource.Resource {
	return resource.NewSchemaless(
		attribute.String(attrServiceName, serviceName),
		attribute.String(attrDeviceID, cfg.DeviceID),
		attribute.String(attrCookID, unsetDimension),
		attribute.String(attrCorrelationID, unsetDimension),
		attribute.String(attrProcessingPath, processingPath),
		attribute.String(attrComponent, componentName),
		attribute.String(attrEnvironment, cfg.Environment),
	)
}

// newSpanExporter returns the span exporter, selected SOLELY by the standard
// OTEL_EXPORTER_OTLP_ENDPOINT environment variable.
//
// An unset (or whitespace-only) OTEL_EXPORTER_OTLP_ENDPOINT yields a no-op
// exporter so the controller runs offline. When it is set, the OTLP/HTTP
// exporter — the swappable concrete backend behind the OTel SpanExporter
// interface — is constructed; otlptracehttp.New reads the endpoint (and the
// other standard OTLP settings) from the environment itself, so the target
// comes only from OTEL_EXPORTER_OTLP_ENDPOINT. No connection string is ever
// consulted. The exporter connects lazily, so construction succeeds even with
// no live backend reachable.
func newSpanExporter(ctx context.Context) (sdktrace.SpanExporter, error) {
	if strings.TrimSpace(os.Getenv(EnvOTLPEndpoint)) == "" {
		return noopExporter{}, nil
	}
	return otlptracehttp.New(ctx)
}

// noopExporter is a span exporter that discards every span. It backs the
// offline / unconfigured path so Setup never fails when no backend is set.
type noopExporter struct{}

func (noopExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error { return nil }

func (noopExporter) Shutdown(context.Context) error { return nil }
