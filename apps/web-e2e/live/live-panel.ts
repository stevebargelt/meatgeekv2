import type { Locator } from '@playwright/test';
import { livePanelConnection, livePanelGaveUp } from './helpers';

/** How often the check reads the panel again. */
const POLL_MS = 250;

/**
 * Step 5's check: the cook page's live panel is connected to the hub. A
 * standing device keeps the last run's reading, so a connected panel can open
 * stale ("No reading for …"); that passes. "Connecting…" and "Reconnecting…"
 * are read again until the panel connects; "Sign in again" fails at once,
 * since the app tries nothing more after it. Shared with the mocked browser
 * test (src/live-panel-connected.spec.ts), which seeds an old reading.
 *
 * `timeoutMs` bounds the wait (the live proof passes 30 s). Without it the
 * check has no deadline of its own: it ends when the panel connects or gives
 * up, or at the test's timeout (HAR-121: the mocked test's verdict never
 * depends on how fast the machine is).
 */
export async function expectLivePanelConnected(panel: Locator, timeoutMs?: number): Promise<void> {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  for (;;) {
    // Short per-read bounds only keep the loop polling while the panel is not
    // on the page yet; a read that misses is read again.
    const state = await panel.getAttribute('data-state', { timeout: 1_000 }).catch(() => null);
    const badge = await panel
      .getByTestId('live-badge')
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    const verdict = livePanelConnection(state, badge);
    if (verdict === 'connected') return;
    if (livePanelGaveUp(state, badge)) {
      throw new Error(`the live panel is not connected, and has stopped trying: ${verdict}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the live panel is not connected within ${(timeoutMs as number) / 1000} s: ${verdict}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
