import { expect, test } from '@playwright/test';
import { clearAuthState, enableE2eFlag, fillEmailPassword, resetAuth } from './helpers';

const PASSWORD = 'KitAuthE2E!2026';
const HOME_URL = /\/main\/kit\/auth\/home/;
const SIGNIN_URL = /\/main\/kit\/auth\/signin/;
const CONFIRM_URL = /\/main\/kit\/auth\/confirm/;

test.describe('Kit Auth (Firebase + confirm bypass)', () => {
  test.beforeEach(async ({ page }) => {
    await enableE2eFlag(page);
  });

  test('signup with UUID email skips confirm and reaches home as user', async ({ page }) => {
    const email = `kit-auth-e2e-${crypto.randomUUID()}@example.com`;
    await resetAuth(page);

    await page.goto('/main/kit/auth/signup');
    await fillEmailPassword(page, email, PASSWORD);
    await page.getByTestId('auth-signup').click();

    // __E2E__ → allowWhen: unverified Firebase user must resolve as 'user', not 'confirm'.
    await page.waitForURL(HOME_URL, { timeout: 30000 });
    await expect(page).not.toHaveURL(CONFIRM_URL);
    await expect(page.getByTestId('auth-home')).toBeVisible();
    await expect(page.getByTestId('auth-state')).toHaveText('user');
    await expect(page.getByTestId('auth-email-display')).toHaveText(email);
  });

  test('sign in reuses the account created in the same test', async ({ page }) => {
    const email = `kit-auth-e2e-${crypto.randomUUID()}@example.com`;
    await resetAuth(page);

    await page.goto('/main/kit/auth/signup');
    await fillEmailPassword(page, email, PASSWORD);
    await page.getByTestId('auth-signup').click();
    await page.waitForURL(HOME_URL, { timeout: 30000 });
    await expect(page.getByTestId('auth-state')).toHaveText('user');
    await expect(page.getByTestId('auth-email-display')).toHaveText(email);

    // Session clear (IndexedDB) — next navigation must treat the client as signed out.
    await clearAuthState(page);
    await page.goto('/main/kit/auth/home');
    await expect(page).toHaveURL(SIGNIN_URL, { timeout: 15000 });

    await page.goto('/main/kit/auth/signin');
    await fillEmailPassword(page, email, PASSWORD);
    await page.getByTestId('auth-signin').click();

    await page.waitForURL(HOME_URL, { timeout: 30000 });
    await expect(page).not.toHaveURL(CONFIRM_URL);
    await expect(page.getByTestId('auth-home')).toBeVisible();
    await expect(page.getByTestId('auth-state')).toHaveText('user');
    await expect(page.getByTestId('auth-email-display')).toHaveText(email);

    await page.getByTestId('auth-signout').click();
    await expect(page).toHaveURL(SIGNIN_URL, { timeout: 15000 });
    // Signed-out user must not stay on the authorized route.
    await page.goto('/main/kit/auth/home');
    await expect(page).toHaveURL(SIGNIN_URL, { timeout: 15000 });
  });
});
