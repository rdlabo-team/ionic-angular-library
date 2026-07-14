import { expect, test } from '@playwright/test';
import { clearAuthState, enableE2eFlag, fillEmailPassword, resetAuth } from './helpers';

const PASSWORD = 'KitAuthE2E!2026';
const HOME_URL = /\/main\/kit\/auth\/home/;

test.describe('Kit Auth (Firebase + confirm bypass)', () => {
  test.beforeEach(async ({ page }) => {
    await enableE2eFlag(page);
  });

  test('signup with UUID email skips confirm and reaches home', async ({ page }) => {
    const email = `kit-auth-e2e-${crypto.randomUUID()}@example.com`;
    await resetAuth(page);

    await page.goto('/main/kit/auth/signup');
    await fillEmailPassword(page, email, PASSWORD);
    await page.getByTestId('auth-signup').click();

    await page.waitForURL(HOME_URL, { timeout: 30000 });
    await expect(page.getByTestId('auth-home')).toBeVisible();
    await expect(page.getByTestId('auth-state')).toHaveText(/user|anonymous/);
    await expect(page.getByTestId('auth-email-display')).toContainText(email);
  });

  test('sign in after signup with the same UUID email', async ({ page }) => {
    const email = `kit-auth-e2e-${crypto.randomUUID()}@example.com`;
    await resetAuth(page);

    await page.goto('/main/kit/auth/signup');
    await fillEmailPassword(page, email, PASSWORD);
    await page.getByTestId('auth-signup').click();
    await page.waitForURL(HOME_URL, { timeout: 30000 });

    await clearAuthState(page);
    await page.goto('/main/kit/auth/signin');

    await fillEmailPassword(page, email, PASSWORD);
    await page.getByTestId('auth-signin').click();

    await page.waitForURL(HOME_URL, { timeout: 30000 });
    await expect(page.getByTestId('auth-home')).toBeVisible();
    await expect(page.getByTestId('auth-email-display')).toContainText(email);

    await page.getByTestId('auth-signout').click();
    await page.waitForURL(/\/main\/kit\/auth\/signin/, { timeout: 15000 });
  });
});
