import type { Page } from '@playwright/test';

/** Must run before any navigation so `environment.e2e` sees `__E2E__` at module load. */
export async function enableE2eFlag(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as { __E2E__?: boolean }).__E2E__ = true;
  });
}

export async function fillEmailPassword(page: Page, email: string, password: string): Promise<void> {
  const emailInput = page.getByTestId('auth-email').locator('input').or(page.locator('input[type="email"]')).first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.fill(email);

  const passwordInput = page.getByTestId('auth-password').locator('input').or(page.locator('input[type="password"]')).first();
  await passwordInput.fill(password);
}

/**
 * Clear Firebase Auth persistence (IndexedDB) plus web storage.
 * localStorage alone is not enough — Firebase keeps the session in IndexedDB.
 */
export async function clearAuthState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // ignore
    }
    try {
      const dbs = (await indexedDB.databases?.()) ?? [];
      await Promise.all(
        dbs.map(({ name }) =>
          name
            ? new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(name);
                req.onsuccess = req.onerror = req.onblocked = () => resolve();
              })
            : Promise.resolve(),
        ),
      );
    } catch {
      // ignore
    }
  });
}

export async function resetAuth(page: Page): Promise<void> {
  await enableE2eFlag(page);
  await page.goto('/main/kit/auth');
  await clearAuthState(page);
  await page.goto('/main/kit/auth');
}
