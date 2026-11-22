import { expect, test } from '@playwright/test';

test('waits for a fixed time', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500); // expect: pw-wait-for-timeout
  await expect(page.getByRole('heading', { name: 'Cooks' })).toBeVisible();
});
