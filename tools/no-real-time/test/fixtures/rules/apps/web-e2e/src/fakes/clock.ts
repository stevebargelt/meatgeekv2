// A test-only helper under src/fakes: scanned like a test. Clean.
export const FROZEN_NOW_MS = Date.UTC(2026, 10, 20, 15, 0, 0);
export async function freezeClock(page: { addInitScript(script: string): Promise<void> }) {
  await page.addInitScript(`Date.now = () => ${FROZEN_NOW_MS};`);
}
