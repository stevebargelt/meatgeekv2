// Package telemetry wires the OpenTelemetry Go trace SDK for the MeatGeek
// device controller.
//
// NewRelic instrumentation was removed in ticket #4; this package re-adds
// observability at the same main.go init site (MG-6). The Azure Monitor Go
// exporter is not GA, so the concrete backend here is OTLP/HTTP behind the
// OTel SpanExporter interface: the exporter targets the App Insights ingestion
// endpoint parsed out of the connection string (or an OpenTelemetry Collector
// pointed at it via OTEL_EXPORTER_OTLP_ENDPOINT), mirroring the data-pusher
// telemetry package. Swap newSpanExporter for the Azure Monitor Go exporter
// once it ships GA.
//
// The controller must run fully offline (e.g. a Raspberry Pi with no backend
// reachable): an empty APPLICATIONINSIGHTS_CONNECTION_STRING selects a no-op
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

// Environment variables read by ConfigFromEnv. The connection string is read
// from the environment ONLY — it is never hardcoded or committed.
//
// APPLICATIONINSIGHTS_CONNECTION_STRING is the Azure-standard name (the same
// name Terraform sets on the Functions app settings); the device controller
// reads it directly since it is edge-deployed rather than Terraform-managed.
const (
	EnvConnectionString = "APPLICATIONINSIGHTS_CONNECTION_STRING"
	EnvEnvironment      = "ENVIRONMENT"
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
	// ConnectionString is the Application Insights connection string
	// (APPLICATIONINSIGHTS_CONNECTION_STRING). Empty selects the no-op exporter.
	ConnectionString string
	// Environment populates the environment custom dimension (ENVIRONMENT).
	Environment string
}

// ConfigFromEnv builds a Config from the environment, using deviceID for the
// device.id dimension.
func ConfigFromEnv(deviceID string) Config {
	return Config{
		DeviceID:         deviceID,
		ConnectionString: os.Getenv(EnvConnectionString),
		Environment:      os.Getenv(EnvEnvironment),
	}
}

// Setup builds the trace TracerProvider, installs it as the global provider,
// installs the W3C Trace Context propagator globally, and returns a shutdown
// func. It always samples (AlwaysSample) and attaches a resource carrying the
// standard MeatGeek custom dimensions.
//
// With an empty ConnectionString the provider uses a no-op exporter so the
// controller runs offline without an Application Insights / OTLP backend and
// never panics. The returned ShutdownFunc always flushes and stops the
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
	exporter, err := newSpanExporter(ctx, cfg.ConnectionString)
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

// newSpanExporter returns the span exporter for the given Application Insights
// connection string.
//
// An empty (or whitespace-only) connection string yields a no-op exporter so
// the controller runs offline. A non-empty connection string yields the
// OTLP/HTTP exporter — the swappable concrete backend behind the OTel
// SpanExporter interface — aimed at the ingestion endpoint parsed from the
// connection string (mirroring data-pusher). The exporter connects lazily, so
// construction succeeds even with no live backend reachable.
func newSpanExporter(ctx context.Context, connectionString string) (sdktrace.SpanExporter, error) {
	if strings.TrimSpace(connectionString) == "" {
		return noopExporter{}, nil
	}
	opts := []otlptracehttp.Option{}
	if endpoint := ingestionEndpoint(connectionString); endpoint != "" {
		opts = append(opts, otlptracehttp.WithEndpointURL(endpoint))
	}
	return otlptracehttp.New(ctx, opts...)
}

// ingestionEndpoint pulls the IngestionEndpoint value out of a standard App
// Insights connection string (semicolon-separated key=value pairs, e.g.
// "InstrumentationKey=...;IngestionEndpoint=https://...;..."). Returns "" when
// absent, in which case the exporter falls back to the OTLP default endpoint
// (or the OTEL_EXPORTER_OTLP_ENDPOINT env override). Mirrors data-pusher's
// helper of the same name so both services parse the connection string
// identically.
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

// noopExporter is a span exporter that discards every span. It backs the
// offline / unconfigured path so Setup never fails when no backend is set.
type noopExporter struct{}

func (noopExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error { return nil }

func (noopExporter) Shutdown(context.Context) error { return nil }
