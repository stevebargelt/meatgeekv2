/**
 * Correlation + standard-dimension helpers for the MeatGeek telemetry pipeline.
 *
 * This is the offline-shippable form of the MG-6 "restore correlation.id on
 * receive" work. There is NO live IoT-Hub receiver Function yet (that lands in
 * Bucket C), so these are pure, unit-tested helpers with no Azure Functions or
 * OpenTelemetry SDK coupling. The eventual receiver wires them together:
 *   1. `extractCorrelation(msg.applicationProperties, context.invocationId)`
 *   2. restore the W3C trace context from the returned `traceparent`
 *   3. attach `getStandardDimensions(...)` to the span.
 */

/**
 * IoT Hub message property carrying the cook-scoped correlation id. Matches the
 * device side constant `CorrelationIDPropertyName = "correlation.id"` in
 * apps/data-pusher/internal/iothub/client.go.
 */
export const CORRELATION_ID_PROPERTY = 'correlation.id';

/** IoT Hub message property carrying the W3C traceparent header. */
export const TRACEPARENT_PROPERTY = 'traceparent';

/**
 * W3C Trace Context `traceparent` shape: version-traceId-parentId-flags, e.g.
 * `00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`. Used only to reject
 * malformed values so context restoration never throws — it is not a full
 * spec-compliant validator (e.g. it does not reject the all-zero trace id).
 */
const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Loose shape of an inbound IoT Hub message's `applicationProperties`. */
export type ApplicationProperties = Record<string, unknown>;

/** Correlation context recovered from an inbound message. */
export interface InboundCorrelation {
  /** Correlation id; the provided `invocationId` when the property is absent. */
  correlationId: string;
  /** Valid W3C traceparent, or `undefined` when absent/malformed. */
  traceparent?: string;
}

/**
 * Restore correlation context from an inbound IoT Hub message's
 * `applicationProperties`.
 *
 * - A missing or non-string `correlation.id` falls back to `invocationId`, so
 *   every processed message still carries a stable correlation key.
 * - A missing or malformed `traceparent` yields `undefined` rather than throwing,
 *   so a bad header degrades to a fresh trace instead of failing the receive.
 */
export function extractCorrelation(
  applicationProperties: ApplicationProperties | undefined | null,
  invocationId: string
): InboundCorrelation {
  const props = applicationProperties ?? {};

  const rawCorrelation = props[CORRELATION_ID_PROPERTY];
  const correlationId =
    typeof rawCorrelation === 'string' && rawCorrelation.length > 0 ? rawCorrelation : invocationId;

  const rawTraceparent = props[TRACEPARENT_PROPERTY];
  const traceparent =
    typeof rawTraceparent === 'string' && TRACEPARENT_RE.test(rawTraceparent)
      ? rawTraceparent
      : undefined;

  return { correlationId, traceparent };
}

/** Known processing paths (see docs/monitoring/observability.md). */
export type ProcessingPath = 'storage' | 'realtime' | 'api';

/** Known component identifiers (see docs/monitoring/observability.md). */
export type Component = 'device' | 'iot-hub' | 'function' | 'client';

/** Inputs for building the six standard custom dimensions. */
export interface StandardDimensionsContext {
  /** Physical device identity, e.g. "meatgeek3". */
  deviceId: string;
  /** Correlation id joining every hop of one reading. */
  correlationId: string;
  /** Active cook id; defaults to "none" when no cook is active. */
  cookId?: string;
  /** Which processing path emitted the span; defaults to "realtime". */
  processingPath?: ProcessingPath;
  /** Emitting component; defaults to "function". */
  component?: Component;
  /** Deployment environment; defaults to `ENVIRONMENT` env or "dev". */
  environment?: string;
}

/** The six standard custom dimensions attached to every telemetry span. */
export interface StandardDimensions {
  'device.id': string;
  'cook.id': string;
  'correlation.id': string;
  'processing.path': string;
  component: string;
  environment: string;
}

/**
 * Build the six standard custom dimensions shared by every span across both the
 * storage and realtime processing paths. The key set is fixed at exactly these
 * six so dashboards and KQL queries (see docs/monitoring/observability.md) can
 * rely on their presence.
 */
export function getStandardDimensions(context: StandardDimensionsContext): StandardDimensions {
  return {
    'device.id': context.deviceId,
    'cook.id': context.cookId || 'none',
    'correlation.id': context.correlationId,
    'processing.path': context.processingPath ?? 'realtime',
    component: context.component ?? 'function',
    environment: context.environment ?? process.env['ENVIRONMENT'] ?? 'dev',
  };
}
