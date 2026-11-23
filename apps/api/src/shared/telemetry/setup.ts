import { useAzureMonitor, AzureMonitorOpenTelemetryOptions } from '@azure/monitor-opentelemetry';
import { ManagedIdentityCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/core-auth';
import { resourceFromAttributes } from '@opentelemetry/resources';

/**
 * Builds the credential the exporters authenticate with. `clientId` is set only
 * for a user-assigned identity (`ClientId=` in the authentication string); the
 * Function App uses its system-assigned identity, so it is normally undefined.
 */
export type TelemetryCredentialFactory = (clientId: string | undefined) => TokenCredential;

export interface TelemetryDeps {
  readonly credentialFactory: TelemetryCredentialFactory;
}

const defaultDeps: TelemetryDeps = {
  // ManagedIdentityCredential, never DefaultAzureCredential, matching the
  // Cosmos, SignalR and IoT Hub adapters.
  credentialFactory: (clientId) =>
    clientId ? new ManagedIdentityCredential(clientId) : new ManagedIdentityCredential(),
};

/**
 * Parses `APPLICATIONINSIGHTS_AUTHENTICATION_STRING`
 * (`Authorization=AAD[;ClientId=<guid>]`). Returns undefined unless it asks
 * for AAD. Keys are case-insensitive, as the Functions host reads them.
 */
export function parseAuthenticationString(
  value: string | undefined
): { clientId: string | undefined } | undefined {
  if (!value) return undefined;
  const pairs = new Map<string, string>();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    pairs.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  if (pairs.get('authorization')?.toUpperCase() !== 'AAD') return undefined;
  return { clientId: pairs.get('clientid') || undefined };
}

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
 * Ingestion is Entra-only: the App Insights resource has
 * `local_authentication_enabled = false`, so the instrumentation key in the
 * connection string cannot authenticate. The Function App sets
 * `APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD`, but only the
 * Functions host reads that setting; the Node exporter attaches a token only
 * when `azureMonitorExporterOptions.credential` is set. So when the setting
 * asks for AAD, this passes the managed identity (which holds Monitoring
 * Metrics Publisher on the resource). Without it every export from this worker
 * is rejected: spans, logs and the `meatgeek.reading.*` metrics (HAR-150).
 *
 * When the connection string is unset/empty (local dev, CI, unit tests) this is
 * a no-op: it logs and returns rather than throwing, so the host still boots
 * without a live Application Insights resource.
 */
export function initializeTelemetry(deps: TelemetryDeps = defaultDeps): void {
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

  const aad = parseAuthenticationString(process.env['APPLICATIONINSIGHTS_AUTHENTICATION_STRING']);
  const azureMonitorExporterOptions: AzureMonitorOpenTelemetryOptions['azureMonitorExporterOptions'] =
    aad ? { connectionString, credential: deps.credentialFactory(aad.clientId) } : { connectionString };

  const options: AzureMonitorOpenTelemetryOptions = {
    azureMonitorExporterOptions,
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
    `initializeTelemetry: Azure Monitor initialised (service.name=meatgeek-api, component=function, environment=${environment}, samplingRatio=0.5, auth=${aad ? 'aad' : 'none'})`
  );
}
