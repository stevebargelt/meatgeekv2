import type { Page } from '@playwright/test';

/**
 * HAR-121: the one instant every fake-backed spec runs at. The browser's
 * `Date` is frozen here (`freezeClock`) and the fakes stamp everything with it
 * (tokens, a cook's start and end, the readings a spec seeds or pushes), so
 * what the app renders from a time ("No reading for 24 min 0 s", live or
 * stale) is the same however long the run takes. Timers keep running, so the
 * app, MSAL and SignalR work as usual; only the time they read stands still.
 *
 * Any fixed instant works; this one is a whole minute, so the fake chart's
 * minute buckets fall on it exactly.
 */
export const FROZEN_NOW_MS = Date.parse('2026-06-01T12:00:00.000Z');

/** `FROZEN_NOW_MS` moved by `offsetMs`, as the ISO string the API sends. */
export const frozenIso = (offsetMs = 0): string => new Date(FROZEN_NOW_MS + offsetMs).toISOString();

/**
 * Freeze the page's `Date.now()` and `new Date()` at FROZEN_NOW_MS, for every
 * page and navigation in its context. Call before the first `page.goto`: the
 * fake Entra's tokens are issued at that instant.
 */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(FROZEN_NOW_MS);
}
