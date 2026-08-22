import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const IOS26_CSS = 'node_modules/@rdlabo/ionic-theme-ios26/dist/css/ionic-theme-ios26.css';
const IOS26_DARK_CLASS_CSS = 'node_modules/@rdlabo/ionic-theme-ios26/dist/css/ionic-theme-ios26-dark-class.css';
const IONIC_DARK_CLASS_CSS = 'node_modules/@ionic/angular/css/palettes/dark.class.css';
const requireFromWorkspace = createRequire(`${process.cwd()}/package.json`);
const PHOTO_EDITOR_IOS26_CSS = requireFromWorkspace.resolve('@rdlabo/ionic-angular-photo-editor/css/ios26-header-button-color-scheme.css');

test('exports a small adapter scoped to photo editor headers', () => {
  const css = readFileSync(PHOTO_EDITOR_IOS26_CSS, 'utf8');
  const selectors = css.split('\n').filter((line) => line.endsWith(' {') && !line.trimStart().startsWith('@'));

  expect(Buffer.byteLength(css)).toBeLessThan(15_000);
  expect(selectors.length).toBeGreaterThan(0);
  expect(selectors.every((selector) => selector.includes('photo-editor-header-buttons-'))).toBe(true);
});

test.describe('Photo editor iOS 26 header button color scheme', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/main/photo-editor?ionic:mode=ios');
    await page.addStyleTag({ path: IOS26_CSS });
    await page.addStyleTag({ path: IONIC_DARK_CLASS_CSS });
    await page.addStyleTag({ path: IOS26_DARK_CLASS_CSS });
    await page.addStyleTag({ path: PHOTO_EDITOR_IOS26_CSS });
  });

  test('forces light buttons inside an ambient dark palette', async ({ page }) => {
    await page.locator('html').evaluate((element) => element.classList.add('ion-palette-dark'));
    await page.getByText('Launch Photo Editor', { exact: true }).click();

    const header = page.locator('ion-modal rdlabo-photo-editor ion-header');
    await expect(page.locator('ion-modal .tui-image-editor-canvas-container canvas').first()).toBeAttached();
    await header.evaluate((element) => {
      element.classList.remove('photo-editor-header-buttons-dark');
      element.classList.add('photo-editor-header-buttons-light');
      (element as HTMLElement).style.colorScheme = 'light';
    });
    const button = header.locator('ion-buttons[slot="start"] ion-button');
    await button.evaluate((element) => element.classList.add('ion-activated'));

    await expect(header).toHaveCSS('--ios26-glass-background-rgb', '255, 255, 255');
    await expect(header).toHaveCSS('--ion-text-color-rgb', '0, 0, 0');
    await expect(button.locator('..')).toHaveCSS('backdrop-filter', 'blur(2px) saturate(3.6)');
  });

  test('forces dark viewer buttons inside an ambient light palette', async ({ page }) => {
    await page.locator('html').evaluate((element) => element.classList.remove('ion-palette-dark'));
    await page.getByText('Launch Photo Viewer', { exact: true }).click();

    const header = page.locator('ion-modal rdlabo-photo-viewer ion-header');
    const button = header.locator('ion-buttons[slot="start"] ion-button');
    await button.evaluate((element) => element.classList.add('ion-activated'));

    await expect(header).toHaveCSS('--ios26-glass-background-rgb', '62, 62, 62');
    await expect(header).toHaveCSS('--ion-text-color-rgb', '255, 255, 255');
    await expect(button.locator('..')).toHaveCSS('backdrop-filter', 'blur(7px) saturate(1.8)');
  });
});
