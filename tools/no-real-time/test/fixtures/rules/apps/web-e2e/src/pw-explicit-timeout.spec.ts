import { expect, test } from '@playwright/test';

test('gives an action and an expect their own deadline', async ({ page }) => {
  test.setTimeout(120_000); // expect: pw-explicit-timeout
  page.setDefaultTimeout(5000); // expect: pw-explicit-timeout
  await page.getByRole('button', { name: 'Start' }).click({ timeout: 2000 }); // expect: pw-explicit-timeout
  await expect(page.getByText('Running')).toBeVisible({ timeout: 10_000 }); // expect: pw-explicit-timeout
  await expect(page.getByText('timeout: none')).toBeVisible(); // in a string: not a hit
});
