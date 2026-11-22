import { expect, test } from '@playwright/test';
import { freezeClock } from './fakes/clock';

// A clean Playwright test: auto-waiting locators and expects, a frozen browser
// clock. Nothing here is a hit.
test('shows the live panel', async ({ page }) => {
  await freezeClock(page);
  await page.clock.install({ time: new Date('2026-11-20T15:00:00.000Z') });
  await page.goto('/cooks/1');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Running')).toBeVisible();
});
