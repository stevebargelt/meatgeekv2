import { expect, type Locator } from '@playwright/test';
import { livePanelConnection } from './helpers';

/**
 * Step 5's check: the cook page's live panel is connected to the hub. A
 * standing device keeps the last run's reading, so a connected panel can open
 * stale ("No reading for …"); that passes. "Connecting…", "Reconnecting…" and
 * "Sign in again" do not. Shared with the mocked browser test
 * (src/live-panel-connected.spec.ts), which seeds an old reading.
 */
export async function expectLivePanelConnected(panel: Locator, timeoutMs: number): Promise<void> {
  await expect
    .poll(
      async () =>
        livePanelConnection(
          await panel.getAttribute('data-state', { timeout: 1_000 }).catch(() => null),
          await panel
            .getByTestId('live-badge')
            .textContent({ timeout: 1_000 })
            .catch(() => null)
        ),
      { message: 'the live panel is not connected', timeout: timeoutMs }
    )
    .toBe('connected');
}
