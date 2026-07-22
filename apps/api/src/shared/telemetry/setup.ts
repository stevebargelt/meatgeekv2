import { useAzureMonitor, AzureMonitorOpenTelemetryOptions } from '@azure/monitor-opentelemetry';
import { resourceFromAttributes } from '@opentelemetry/resources';

/**
 * Initialise Azure Monitor OpenTelemetry for the Functions host.
 *
 * The Application Insights connection string is read STRICTLY from
 * `process.env.APPLICATIONINSIGHTS_CONNECTION_STRING` (the Azure-standard name
 * the Function App sets — see modules/functions/main.tf) — there is deliberately no literal
 * fallback, so a misconfigured environment fails safe (telemetry off) rather
 * than shipping to a stale or default resource.
 *
 * The MG-6 "50% Functions sampling" acceptance criterion lives HERE, via
 * `samplingRatio: 0.5`. It is NOT host.json's adaptive `samplingSettings`, which
 * is a separate, unrelated knob (and is intentionally left as-is).
 *
 * When the connection string is unset/empty (local dev, CI, unit tests) this is
 * a no-op: it logs and returns rather than throwing, so the host still boots
 * without a live Application Insights resource.
 */
export function initializeTelemetry(): void {
  const connectionString = process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'];

  if (!connectionString) {
    console.log(
      'initializeTelemetry: APPLICATIONINSIGHTS_CONNECTION_STRING is unset — skipping Azure Monitor setup'
    );
    return;
  }

  // 'dev' matches the environment convention used across the standard custom
  // dimensions (see docs/monitoring/observability.md and correlation.ts).
  const environment = process.env['ENVIRONMENT'] || 'dev';

  const options: AzureMonitorOpenTelemetryOptions = {
    azureMonitorExporterOptions: { connectionString },
    // MG-6 AC: sample 50% of Functions telemetry at the SDK level.
    samplingRatio: 0.5,
    // Only the environment-invariant, process-init-static standard dimensions
    // belong on the resource: service.name, component, and environment. The
    // per-request/per-span dimensions (device.id, cook.id, correlation.id,
    // processing.path) are NOT static — the correlation.ts helper attaches them
    // per span when a receiver exists. `component` is 'function' to match the
    // Component taxonomy in correlation.ts and the per-span value the Functions
    // app already emits (see docs/monitoring/observability.md).
    resource: resourceFromAttributes({
      'service.name': 'meatgeek-api',
      component: 'function',
      environment,
    }),
  };

  useAzureMonitor(options);

  console.log(
    `initializeTelemetry: Azure Monitor initialised (service.name=meatgeek-api, component=function, environment=${environment}, samplingRatio=0.5)`
  );
}
