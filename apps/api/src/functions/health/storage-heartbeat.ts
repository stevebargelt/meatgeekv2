import type { InvocationContext, Timer } from '@azure/functions';

/**
 * MG-58 — the host-storage proof path.
 *
 * `AzureWebJobsStorage` is the Functions HOST's own storage account, not the
 * app's. Nothing in this API touched it: main.ts registered seven HTTP triggers
 * and nothing else, host.json declares no durable extension, and no
 * queue/table/blob/eventHub binding exists anywhere in apps/api/src. HTTP
 * triggers do not need host storage, which is exactly why the host could sit at
 * `azure.functions.webjobs.storage: Unhealthy / AuthenticationFailed` for weeks
 * while every endpoint answered 200 and nobody noticed.
 *
 * A TIMER is the right probe for that, and the reason is mechanical rather than
 * stylistic: the host persists a timer's schedule status and takes the
 * singleton lease for it IN THE HOST STORAGE ACCOUNT. So this function
 * genuinely cannot fire while AzureWebJobsStorage is unauthenticated — its
 * invocation is the evidence, and no assertion inside the handler is needed or
 * wanted. A storage-touching HTTP endpoint would have proved the same thing only
 * after an Entra bearer-token dance, because the MG-24 platform gate
 * (auth_settings_v2, unauthenticated_action = Return401) applies to HTTP alone.
 *
 * Follows the MG-51 /api/health/cosmos precedent: a purpose-built surface added
 * because no pre-existing surface touched the dependency.
 *
 * This is PERMANENT app surface, not a throwaway probe. Removing it makes the
 * MG-58 acceptance evidence non-reproducible, and while App Insights emits
 * nothing in dev (MG-37) this is the only continuous signal that host storage
 * still works.
 *
 * What it deliberately does NOT do: write a blob by hand, take a dependency on
 * an Azure SDK, or assert anything about storage itself. The storage dependency
 * belongs to the HOST, and a hand-rolled write would prove a different thing —
 * the identity's data-plane access from application code — while adding a
 * writer to an account whose whole posture is that the app writes nothing to it.
 * The handler logs and returns.
 */

/**
 * Every 15 minutes, on the quarter hour (NCRONTAB is second-first, six fields).
 *
 * Low frequency on purpose: this runs on every instance for the life of the app,
 * and its only consumer is a human reading FunctionAppLogs. Fifteen minutes
 * bounds the wait for evidence after a deploy or a host restart without adding
 * meaningful ingestion to a dev workspace that has a hard 2 GB/day cap.
 */
export const STORAGE_HEARTBEAT_SCHEDULE = '0 */15 * * * *';

/**
 * The stable string the MG-58 runbook greps for in FunctionAppLogs. It is part
 * of the contract with that runbook: changing it silently breaks the documented
 * KQL, so the spec pins it.
 */
export const STORAGE_HEARTBEAT_MARKER = 'storage-heartbeat';

/**
 * Renders the one line this function emits.
 *
 * `scheduleStatus` is the interesting part: the host reads it back FROM host
 * storage, so its presence is a second-order confirmation that the read
 * succeeded and not merely that a lease was granted. It arrives from the host,
 * though, so it is treated as untrusted input the same way cosmos-health treats
 * a dependency's error text — each field is accepted only if it parses as a
 * timestamp and is re-emitted in ISO form, never echoed verbatim. That keeps the
 * log line's vocabulary fixed: a marker, an invocation id, a boolean, and
 * timestamps.
 */
export function formatStorageHeartbeat(timer: Timer | undefined, invocationId: string): string {
  const fields = [
    `invocation=${invocationId}`,
    `pastDue=${timer?.isPastDue === true}`,
    `lastRun=${isoOrUnknown(timer?.scheduleStatus?.last)}`,
    `nextRun=${isoOrUnknown(timer?.scheduleStatus?.next)}`,
  ];

  return (
    `${STORAGE_HEARTBEAT_MARKER}: timer fired, so the Functions host holds its ` +
    `schedule status and singleton lease in AzureWebJobsStorage (MG-58) — ${fields.join(' ')}`
  );
}

/** Timestamps only; anything else the host phrased as text is discarded here. */
function isoOrUnknown(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 'unknown' : new Date(parsed).toISOString();
}

/**
 * Logs the heartbeat and returns. It has no failure mode of its own on purpose:
 * a throw here would show up as a failed invocation and be read as "host storage
 * is broken", which is the one conclusion this function must never produce
 * falsely. The absence of the invocation is the negative signal.
 */
export async function storageHeartbeatHandler(
  timer: Timer,
  context: InvocationContext
): Promise<void> {
  context.log(formatStorageHeartbeat(timer, context.invocationId));
}
