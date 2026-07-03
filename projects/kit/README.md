# @rdlabo/ionic-angular-kit

A small ergonomic kit for Ionic Angular applications. It provides:

- **KitStorageService** — a typed, write-loss-safe wrapper around `@ionic/storage-angular`
- **KitOverlayController** — a unified presenter for Ionic Modal, Toast, and Alert
- **Auth guards** — functional `CanActivateFn` guards for a 4-state auth model
- **HTTP interceptor** — a fleet-canonical auth + retry + error-hook interceptor
- **KitAutofillDirective** — an iOS autofill workaround for `ion-input`

---

## Install

```bash
npm install @rdlabo/ionic-angular-kit
```

### Peer dependencies

| Package | Version |
|---|---|
| `@angular/common` | `^21.0.0` |
| `@angular/core` | `^21.0.0` |
| `@angular/router` | `^21.0.0` |
| `@ionic/angular` | `^8.0.0` |
| `@ionic/storage-angular` | `^4.0.0` |
| `@capacitor/core` | `>=6.0.0 <9.0.0` |
| `@capacitor/haptics` | `>=6.0.0 <9.0.0` |
| `@capacitor/keyboard` | `>=6.0.0 <9.0.0` |
| `@capacitor/network` | `>=6.0.0 <9.0.0` |
| `@capacitor/preferences` | `>=6.0.0 <9.0.0` |
| `@capacitor/status-bar` | `>=6.0.0 <9.0.0` |
| `@capacitor-community/in-app-review` | `>=6.0.0 <9.0.0` |
| `@rdlabo/capacitor-brotherprint` | `>=6.0.0 <9.0.0` |
| `dom-to-image-more` | `^3.0.0` |
| `rxjs` | `^7.8.0` |

Feature-scoped peers are only needed by the features that use them (`status-bar` → `KitThemeController`; `preferences` + `in-app-review` → `kitRequestReview`; `capacitor-brotherprint` + `dom-to-image-more` → the printer helpers); an app that doesn't use a feature can ignore its unmet-peer warning.

---

## Features

### KitStorageService

A typed wrapper around `@ionic/storage-angular` that guarantees writes are never silently dropped even when called immediately after service creation.

**How it works:** `Storage.create()` is awaited exactly once internally (via a private `#ready` promise). Every public method awaits `#ready` before operating, so callers never need a separate init step.

**Setup** — provide `IonicStorageModule` (or equivalent) alongside the service:

```typescript
// app.config.ts
import { IonicStorageModule } from '@ionic/storage-angular';
import { importProvidersFrom } from '@angular/core';

export const appConfig: ApplicationConfig = {
  providers: [
    importProvidersFrom(IonicStorageModule.withConfig({ name: '__mydb' })),
  ],
};
```

**Usage**

```typescript
import { KitStorageService } from '@rdlabo/ionic-angular-kit';

@Injectable({ providedIn: 'root' })
export class TokenService {
  readonly #storage = inject(KitStorageService);

  async saveToken(token: string): Promise<void> {
    await this.#storage.set('token', token);
  }

  async getToken(): Promise<string | null> {
    return this.#storage.get<string>('token');
  }
}
```

**API**

```typescript
set<T>(key: string, value: T): Promise<void>
get<T>(key: string): Promise<T | null>     // returns null (not undefined) for missing keys
remove(key: string): Promise<void>
clear(): Promise<void>
keys(): Promise<string[]>
```

---

### KitOverlayController + provideKitOverlay

A unified presenter for Ionic Modal, Toast, and Alert that folds create → present → dismiss into a single awaitable call.

**Convention:** button labels (`close`, `cancel`) are **not hard-coded** in the kit. The consuming application must inject them via `provideKitOverlay`. This keeps the kit independent of `@angular/localize` and lets each app supply translated strings.

**Setup**

```typescript
// app.config.ts
import { provideKitOverlay } from '@rdlabo/ionic-angular-kit';

export const appConfig: ApplicationConfig = {
  providers: [
    provideKitOverlay({
      labels: {
        close: $localize`閉じる`,
        cancel: $localize`キャンセル`,
      },
    }),
  ],
};
```

**Usage**

```typescript
import { KitOverlayController } from '@rdlabo/ionic-angular-kit';

@Component({ ... })
export class MyPage {
  readonly #overlay = inject(KitOverlayController);

  async openDetail(): Promise<void> {
    const result = await this.#overlay.presentModal(DetailPage, { item });
    // result type is inferred from `declare static modalReturn` on DetailPage
  }

  async confirm(): Promise<void> {
    const ok = await this.#overlay.alertConfirm({
      header: 'Delete',
      message: 'Are you sure?',
      okText: 'Delete',
    });
    if (ok) { /* proceed */ }
  }

  async notify(message: string): Promise<void> {
    await this.#overlay.presentToast({ message });
  }
}
```

**API**

```typescript
presentModal<C extends ModalOptions['component']>(
  component: C,
  ...args: ModalPresentArgs<C>,  // props inferred from input() fields; options?: KitModalPresentOptions
): Promise<ModalReturnOf<C> | undefined>
// Props inferred from the component's input() fields (required/optional).
// Return type inferred from `declare static modalReturn: T` on the component (void if absent).

presentPopover<O>(
  component: PopoverOptions['component'],
  componentProps?: PopoverOptions['componentProps'],
  options?: Omit<PopoverOptions, 'component'|'componentProps'>,   // e.g. { event } to anchor it
): Promise<O | undefined>

presentToast(options: ToastOptions): Promise<HTMLIonToastElement>
// kit defaults: position='bottom', duration=2000, swipeGesture='vertical'
// A bottom toast with no explicit positionAnchor auto-anchors above a visible <ion-tab-bar>
// (so it clears the tabs); keyboard avoidance rides the native keyboard resize.
// caller options spread over the defaults — any field can be overridden

alertClose(options: { header: string; message: string; subHeader?: string }): Promise<void>

alertConfirm(options: {
  header: string;
  message: string;
  okText: string;
  subHeader?: string;
}): Promise<boolean>   // true iff role === 'confirm'
```

`watchKeyboard: true` (on `presentModal` options) expands a bottom sheet to full height when the native keyboard appears (iOS/Android only; no-op on web).

**How `presentModal` decides required vs. optional props.** Props are inferred from the component's `input()` fields, and whether each prop is **required** or **optional** is decided by a single rule: *does the input's type include `undefined`?* A default value is not "optional" — providing a default removes `undefined` from the input's type, so a defaulted input becomes a **required** prop.

| Declaration              | Input type      | Includes `undefined`? | Prop                              |
| ------------------------ | --------------- | --------------------- | --------------------------------- |
| `input.required<T>()`    | `T`             | No                    | required                          |
| `input<T>(defaultValue)` | `T`             | No                    | **required** ← a default makes it required |
| `input<T>()` (no arg)    | `T \| undefined`| Yes                   | optional                          |

To make a prop **optional**, drop the default and use a bare `input<T>()` (its type is `T | undefined`), then apply your fallback where you read it (e.g. `this.enabled() ?? true`). If a component has at least one required input, the `componentProps` argument itself becomes mandatory; if it has no required inputs, `componentProps` may be omitted; a component with no `input()` fields at all accepts loose, untyped props.

**Best practice — the modal launcher pattern.** Never call `modalController.create(...)` inline in a component. Instead, each modal/popover page exports a typed launcher next to itself and every call site goes through `KitOverlayController`:

```typescript
// detail.page.ts — component declares its return type:
export class DetailPage {
  declare static readonly modalReturn: DetailResult;
  readonly item = input.required<Item>();
}

export const launchDetailPage = (overlay: KitOverlayController, props: { item: Item }): Promise<DetailResult | undefined> =>
  overlay.presentModal(DetailPage, props, { backdropDismiss: false });
```

This centralizes presentation options, keeps component props and dismiss data type-safe, and makes every modal discoverable. A well-disciplined app has **zero** inline `controller.create()` calls.

---

### Auth guards + provideKitAuth

Functional `CanActivateFn` guards for a four-state auth model:

| State | Meaning |
|---|---|
| `'user'` | Fully authenticated |
| `'confirm'` | Authenticated but email confirmation pending |
| `'required'` | Not authenticated |
| `'anonymous'` | Anonymous login active (can be prompted to register) |

**Convention:** every redirect path is supplied via `provideKitAuth`; the kit does not hard-code any routes. `authState` and `redirects` are required. The app-specific hooks `onAuthorized` / `onUnauthenticated` are **optional** and default to `true` (allow the authenticated user through) / `false` (fall through to the `whenUnauthorized` redirect), so an app only supplies the ones with real logic.

**Setup**

```typescript
// app.config.ts
import { provideKitAuth } from '@rdlabo/ionic-angular-kit';

export const appConfig: ApplicationConfig = {
  providers: [
    provideKitAuth(() => {
      const auth = inject(AuthService);
      return {
        authState: () => auth.state$,   // Observable<KitAuthState>
        redirects: {
          whenAuthorized: '/home',          // kitRequiredUnauthorizedGuard
          whenConfirming: '/auth/confirm',  // kitRequiredUnauthorizedGuard
          whenNotConfirming: '/auth/signin',// kitRequireConfirmingGuard
          whenUnauthorized: '/auth',        // kitRequireAuthorizedGuard
        },
        // onAuthorized / onUnauthenticated omitted → defaults (allow / redirect).
        // Supply onAuthorized only when 'user' needs extra work (token login, permissions):
        // onAuthorized: async () => { await auth.refreshToken(); return true; },
        // Supply onUnauthenticated only for a fallback such as anonymous sign-in:
        // onUnauthenticated: async () => { await auth.signInAnonymously(); return true; },
      };
    }),
  ],
};
```

### kitPresentAuthFailedAlert

The fleet's canonical "sign-in / token exchange failed" alert: an informative alert (header + optional server error as sub-header + detail message) with a single close button that reloads the app so the user restarts cleanly. Text is passed in (no hardcoded i18n); the caller signs the user out around it. A standalone helper (takes `AlertController`) since `location.reload()` is navigation policy the overlay controller does not hold.

```typescript
import { kitPresentAuthFailedAlert } from '@rdlabo/ionic-angular-kit';

const logged = await auth.tokenLogin().catch(async (e) => {
  await kitPresentAuthFailedAlert(alertCtrl, {
    header: 'ログインできませんでした',
    subHeader: e.error.error,
    message: e.error.detail,
    closeText: '閉じる',
  });
  await auth.signOut();
  return undefined;
});
```

**Guards**

```typescript
// routes.ts
import {
  kitRequiredUnauthorizedGuard,
  kitRequireConfirmingGuard,
  kitRequireAuthorizedGuard,
} from '@rdlabo/ionic-angular-kit';

export const routes: Routes = [
  {
    path: 'auth',
    canActivate: [kitRequiredUnauthorizedGuard],
    // Blocks 'user' → redirects whenAuthorized
    // Blocks 'confirm' → redirects whenConfirming
    // Allows 'required' and 'anonymous'
    loadChildren: () => import('./auth/routes'),
  },
  {
    path: 'confirm',
    canActivate: [kitRequireConfirmingGuard],
    // Allows only 'confirm'
    // 'anonymous' → redirects whenAuthorized
    // 'required'/'user' → redirects whenNotConfirming
    loadComponent: () => import('./confirm/confirm.page'),
  },
  {
    path: 'app',
    canActivate: [kitRequireAuthorizedGuard],
    // 'user' → calls onAuthorized → proceeds on true, redirects on UrlTree
    // 'anonymous' → allowed (anonymous browsing)
    // 'required'/'confirm' → calls onUnauthenticated → proceeds on true/UrlTree, redirects whenUnauthorized on false
    loadChildren: () => import('./main/routes'),
  },
];
```

---

### kitAuthInterceptor + provideKitHttp

A fleet-canonical HTTP interceptor with:

- Per-request auth header injection
- Configurable bypass (CDN, S3, external URLs)
- **Safe retry**: only idempotent methods (`GET`/`HEAD`/`OPTIONS`, or a request with an `Idempotency-Key`) are retried, and only on a transient status `[0, 408, 429, 502, 503, 504]`, up to 2 times with a short jittered backoff (honoring `Retry-After`). **Writes are never auto-retried** (no duplicate saves).
- **Offline fast-fail**: when the device is offline the interceptor stops retrying immediately and hands off to `offlineFallback` instead of waiting out the backoff.
- **Status classification**: `0`→`onNetworkError` (connected only), `429`→`onRateLimited`, `502/503/504`→`onServerBusy`, `400/422/500`+message→`onServerError`, `401`→`onUnauthorized`, `403`→`onForbidden`. Other statuses (e.g. `404`) are left to the caller.
- **Universal 60s timeout** — every request fails with a synthetic (retryable) `408` if it hangs for 60s. Deliberately generous (catches a dead server without cutting off a large upload / AI generation; `timeout({ each })` resets per emission, so streaming is unaffected). Not configurable — one fleet-wide behavior.
- **Optional `treatAsError(response)`** — reject a 2xx (e.g. `204`/`206`) as an error when a backend uses it to signal a condition. The one genuinely app-specific bit (some apps receive a normal `204`), kept optional so class interceptors with a 2xx-as-error convention can migrate to `provideKitHttp`.

**Convention:** all app-specific logic (auth headers, error UI) lives in the config factory. The retry policy, bypass evaluation, and error dispatch are fixed in the kit and not overridable per-call.

**Only `getAuthHeaders` is required.** Every other hook is optional and defaults to a safe no-op (`buildExtraHeaders` → `{}`, `bypass` → `false`, `offlineFallback` → `null`), so a config specifies only the behavior that actually differs from the baseline.

**Setup**

```typescript
// app.config.ts
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { kitAuthInterceptor, provideKitHttp, KitReloadAlertController } from '@rdlabo/ionic-angular-kit';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([kitAuthInterceptor])),
    provideKitHttp(() => {
      const auth = inject(AuthService);
      const reload = inject(KitReloadAlertController);
      return {
        getAuthHeaders: async (req) => ({
          Authorization: `Bearer ${await auth.getToken()}`,
        }),
        onUnauthorized: (req) => auth.signOut(),
        // Fleet-canonical "network error → offer reload" (see KitReloadAlertController).
        onNetworkError: (status) =>
          reload.present({
            header: 'ネットワークエラー',
            message: `通信できませんでした。リフレッシュしますか？（${status}）`,
            okText: 'リフレッシュ',
          }),
        // Auto-dismiss the stale alert once connectivity is back.
        onResponse: () => void reload.dismiss(),
        // buildExtraHeaders / bypass / offlineFallback / onForbidden / onServerError omitted → kit defaults.
      };
    }),
  ],
};
```

**Error dispatch** (after retries, in `catchError`):
1. `offlineFallback` non-null → return fallback observable (no further hooks called)
2. `401` → `onUnauthorized` · `403` → `onForbidden`
3. `0` (connected) → `onNetworkError` · `429` → `onRateLimited(retryAfter?)` · `502/503/504` → `onServerBusy(status, retryAfter?)`
4. `400/422/500` with `error.message` → `onServerError`
5. anything else (`404`, …) → not handled here; the caller decides

Plus: a `getAuthHeaders` rejection → `onAuthError(request, error)` (the request is never sent).

**Note (0.0.9):** `onNetworkError` is now narrowed to genuine network failures (status `0`); `502/503/429` moved to `onServerBusy`/`onRateLimited`. Existing configs stay valid — they just fire less often — so adopt the new hooks only if you want to distinguish server-busy / rate-limit from a connection loss.

### KitReloadAlertController

The fleet's canonical "network error → offer to reload" alert, as a stateful controller that unifies the good-UX variant that had drifted across apps:

- **De-dup** — never stacks; a second `present()` while one is showing is a no-op.
- **Backdrop lock** — `backdropDismiss: false`, so a critical error isn't dismissed by an accidental backdrop tap.
- **Auto-dismiss on reconnect** — `dismiss()` (called from a later successful response) clears a now-stale error alert.
- **Reload on confirm** — the confirm button calls `location.reload()`; cancel uses the configured `labels.cancel`.

All text is passed in, so the kit stays free of hardcoded i18n. Wire `present` from a network-class error and `dismiss` from a success (interceptor `onResponse`, or a class interceptor's success path).

```typescript
import { KitReloadAlertController } from '@rdlabo/ionic-angular-kit';

const reload = inject(KitReloadAlertController);
await reload.present({
  header: 'ネットワークエラー',
  message: `通信できませんでした。リフレッシュしますか？（${status}）`,
  okText: 'リフレッシュ',
});
// later, on a successful response:
await reload.dismiss();
```

---

### KitAutofillDirective

An iOS workaround for `ion-input` autofill (password managers, iCloud Keychain). Without it, autofilled values are not reflected in the Angular form model on iOS native.

```html
<ion-input rdlaboAutofill formControlName="password" type="password" />
```

The directive is a no-op on non-iOS platforms.

---

### kitKeyboardInit

A plain function (no DI — reads the platform from `Capacitor`, so nothing to inject) that registers native keyboard show/hide listeners to reposition an element when the soft keyboard appears — useful for a footer input bar that must stay above the keyboard. A no-op on web (returns `[]`); SSR-safe (the global `document`/`window` are only read inside native callbacks). Three adjustment strategies:

- `transform` — `translateY(-keyboardHeight + safeAreaBottom)` (smooth iOS animation; typical for `ion-footer`)
- `offset` — sets the `--offset-bottom` custom property
- `keyboard-offset` — sets the `--padding-bottom` custom property

```typescript
import { kitKeyboardInit } from '@rdlabo/ionic-angular-kit';

export class ComposePage {
  readonly #footer = viewChild.required<ElementRef>('footer');
  #handles: PluginListenerHandle[] = [];

  async ngAfterViewInit() {
    this.#handles = await kitKeyboardInit(this.#footer(), 'transform');
  }
  ngOnDestroy() {
    this.#handles.forEach((h) => h.remove()); // caller owns the handles
  }
}
```

---

### KitThemeController + provideKitTheme

Light/dark theme controller that unifies the theme logic that had drifted across the fleet: it persists the user's choice, follows the OS `prefers-color-scheme` until the user overrides it, toggles the configured palette classes, and syncs the native Android status bar. It also fixes a latent leak in one variant where the system-theme listener stayed registered after a manual toggle — `changeTheme()` always detaches the listener first, so a later OS change can't silently flip an app the user pinned.

Per-app CSS differences are absorbed by config: `darkClasses` are toggled on when dark, `lightClasses` on when light. The kit ships no class names of its own. Subscribe to `themeSubject` (a `BehaviorSubject`) to reflect the current mode in the UI. It is a controller (not a plain function) because the subject and OS-listener are shared state across the app lifetime.

```typescript
// app.config.ts
provideKitTheme({
  storageKey: StorageKeyEnum.theme,
  darkClasses: ['ion-palette-dark', 'a2ui-dark'],
  lightClasses: ['a2ui-light'],
});

// app.component.ts — apply on boot
inject(KitThemeController).setDefaultThemeMode();

// settings page — bind a toggle
const theme = inject(KitThemeController);
theme.themeSubject.subscribe((mode) => this.isDark.set(mode === 'dark'));
theme.changeTheme(true); // force dark, stop following the OS
```

---

### kitRequestReview

A plain function (no DI — `@capacitor/preferences`, `@capacitor-community/in-app-review` and `Capacitor` are all static) that requests the native in-app review dialog, throttled so the user is prompted at most once per window. A no-op on web. The wait/throttle/record sequence was previously copy-pasted verbatim across the fleet; centralizing it means a single place to tune the prompt cadence. The storage key and throttle window are passed as arguments, so the kit ships no config of its own.

```typescript
import { kitRequestReview } from '@rdlabo/ionic-angular-kit';

await kitRequestReview({ storageKey: StorageEnum.lastRequestRate, throttleMonths: 3 });
```

---

### Utilities

Framework-agnostic helpers (no DI required unless noted):

```typescript
import { kitImpact, arrayConcatById, objectEqual, disableHandler } from '@rdlabo/ionic-angular-kit';

// Native light haptic (no-op on web).
await kitImpact();

// Merge a paginated page into an existing list by numeric id, sorted; new items win on duplicates.
// Optional 5th arg `secondaryKey` drops old items sharing that secondary field with any new item.
const merged = arrayConcatById(loaded, nextPage, 'id', 'DESC', 'parentId');

// Order-independent deep equality (sorted-entries JSON) for cheap "did this state change?" checks.
if (!objectEqual(prev, next)) { /* changed */ }

// Disable the clicked button while an async op runs, re-enabling it after (even on error).
async onSubmit(event: Event) {
  await disableHandler(event, this.save());
}
```

Ionic-event / lifecycle helpers:

```typescript
import { kitChangeEventDisabled, kitCreateDidEnter } from '@rdlabo/ionic-angular-kit';

// Toggle a signal-held ion-infinite-scroll / ion-refresher's `disabled` (no-op when empty).
kitChangeEventDisabled(infiniteScrollSignal, true);

// Observe an Ionic page's "is entered" state from its lifecycle DOM events (true on didEnter).
readonly isEntered = toSignal(kitCreateDidEnter(inject(ElementRef)), { initialValue: false });
```

---

### kitPresentLanguageActionSheet

A plain function (the `ActionSheetController` is passed in — nothing injected) that presents a language picker and, on a new selection, reloads the app at that locale's entry point. Unifies the language-switch flow duplicated across apps: it stashes the current path in `sessionStorage` (to restore after reload), records the chosen locale in `localStorage`, and calls `window.location.replace()` with the app-provided URL. Being a navigation helper, it stays standalone rather than part of a controller. All text, the locale list, and the per-locale URL mapping are injected, so the kit stays free of i18n strings.

```typescript
import { kitPresentLanguageActionSheet } from '@rdlabo/ionic-angular-kit';

await kitPresentLanguageActionSheet(inject(ActionSheetController), {
  header: $localize`言語設定`,
  locales: [{ text: 'English', data: 'en-US' }, { text: '日本語', data: 'ja' }],
  cancelText: $localize`キャンセル`,
  currentLocale: normalizedLocale,
  currentPath: this.#router.url,
  pathnameStorageKey: StorageKeyEnum.pathnameBeforeRedirect,
  buildRedirectUrl: (locale) => location.origin + (localePath[locale.toLowerCase()] ?? '/index.html'),
  enabled: environment.production,
});
```

---

### Printer (Brother label plumbing)

Three pure functions (no DI) that extract the i18n-free core of the fleet's Brother label printing, so a device-quirk or print-setting fix lands in every app at once. The UI orchestration — search/channel-selection alerts, loading overlays, and the app-specific paper list — stays in each app, since those diverge (labels, paper options, copies policy).

- `kitDomToPng(element, { rotate?, scale? })` — render a DOM element to a base64 PNG with the fleet's device fixes (iOS +2px to avoid bottom clipping, none on Android to avoid a black line; retries up to 10×). The caller presents its own loading UI.
- `kitRotationImage(base64)` — rotate a base64 image 90° via canvas.
- `kitBuildBrotherPrintSettings({ modelName, printBase64, label, numberOfCopies, halftoneThreshold })` — assemble the canonical `BRLMPrintOptions` (fit-page, centered, best quality, threshold halftone, standard margins, tape size parsed from the label's `W<w>H<h>` code). Merge `{ port, channelInfo }` from the selected channel before calling `BrotherPrint.printImage()`.

```typescript
import { kitDomToPng, kitBuildBrotherPrintSettings } from '@rdlabo/ionic-angular-kit';

const png = await kitDomToPng(this.preview().nativeElement, { rotate: true });
const settings = kitBuildBrotherPrintSettings({
  modelName, printBase64: png, label,
  numberOfCopies: printOptions.printNum,
  halftoneThreshold: printOptions.halftoneThreshold,
});
await BrotherPrint.printImage({ ...settings, port: channel.port, channelInfo: channel.channelInfo });
```

---

### Firebase auth (`@rdlabo/ionic-angular-kit/auth-firebase`)

A secondary entry point so only apps that use it pull in `@angular/fire` and `firebase`. It exists to **isolate `@angular/fire`**: the SDK is touched in exactly one place — the DI provider — so apps import `KIT_FIREBASE_AUTH` and call these functions, never `@angular/fire` directly. That keeps the eventual `@angular/fire` → modular `firebase/auth` swap provider-local.

**Design principle: the kit performs no UI.** Every function runs the Firebase operation and nothing else; loading overlays, prompts and error alerts are app side effects. The flow functions take the uniform lifecycle hooks `{ before, success, error, finally }` and, rather than throwing, resolve value flows to `null` and boolean flows to `false`, handing the raw error to the `error` hook so the app presents it from its own dictionary. For anything the functions don't express, drop down to `firebase/auth` directly.

```typescript
// app.config.ts — @angular/fire lives only here
provideKitFirebase({ firebaseConfig: environment.firebase }),
provideKitFirebaseAnalytics(),
```

```typescript
import { inject, Injectable } from '@angular/core';
import {
  KIT_FIREBASE_AUTH, kitSignIn, kitSignOut, kitResolveAuthStatus, kitReauthWithRetry,
} from '@rdlabo/ionic-angular-kit/auth-firebase';
import { updatePassword } from 'firebase/auth'; // escape hatch for the reauth mutation

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly #auth = inject(KIT_FIREBASE_AUTH);

  // Simple flow: hooks carry the app's side effects; errors go to the app's own dictionary.
  signIn(email: string, password: string) {
    return kitSignIn(this.#auth, email, password, {
      error: (e) => this.presentError(e),
      success: () => this.nav.navigateRoot('/'),
    });
  }

  // Re-auth: the kit owns only the re-auth + wrong-password-retry mechanic; the app supplies
  // the password prompt and the loading overlay, and catches the thrown (non-wrong-password) error.
  async changePassword(currentEmail: string, newPassword: string) {
    const ok = await kitReauthWithRetry(this.#auth, currentEmail, {
      prompt: (retry) => this.promptPassword(retry),
      mutate: (user) => updatePassword(user, newPassword),
      withLoading: (run) => this.withLoading(run),
    }).catch((e) => (this.presentError(e), false));
    if (ok) this.overlay.alertClose({ header: 'Saved', message: '…' });
  }
}
```

Surface:

- **DI** — `KIT_FIREBASE_AUTH` (`InjectionToken<Auth>`), `provideKitFirebase({ firebaseConfig })`, `provideKitFirebaseAnalytics()`.
- **Flow functions** (uniform hooks + no-throw null/false) — `kitSignIn`, `kitSignUp` (create + send verification), `kitSignOut`, `kitSendPasswordReset`, `kitSendEmailVerification`, `kitUnlinkProvider`.
- **Mechanics** — `kitReauthWithRetry` (app injects `prompt` / `withLoading` / `mutate`; boolean result, non-wrong-password errors thrown), `kitResolveAuthStatus` (`'user' | 'confirm' | 'required'` from the user; social counts as verified; `allowWhen` bypass), `kitAuthState`, `kitGetIdToken`.
- **Error dictionary** — `KIT_DEFAULT_AUTH_TEXT` (importable canonical constant; the kit does not present it — the app renders its own alert).
- **Social** (`@rdlabo/ionic-angular-kit/auth-firebase/social`, separate nested entry to isolate the Capacitor plugins) — `kitFacebookLogin`, `kitAppleLogin`, `kitFacebookLogout`; options carry the same `{ before, success, error, finally }` hooks (`success` receives the identity payload for a backend call).

---

## Consumer Vitest setup notes

When testing a consumer app that declares `@rdlabo/ionic-angular-kit` as a `file:` symlink dependency, add the following to your `vitest.config.ts`:

```typescript
// vitest.config.ts
export default defineConfig({
  resolve: {
    dedupe: [
      '@angular/core',
      '@angular/common',
      '@angular/router',
      '@ionic/angular',
      '@ionic/core',
      'rxjs',
    ],
  },
  test: {
    server: {
      deps: {
        inline: [
          /@ionic\/angular/,
          /@ionic\/core/,
          /ionicons/,
          /@rdlabo\/ionic-angular-kit/,  // inline the kit itself
        ],
      },
    },
  },
});
```

- `resolve.dedupe` prevents Angular's `inject()` from throwing `NG0203 (must be called in an injection context)` when the symlinked kit resolves a different copy of `@angular/core`.
- `server.deps.inline` is required for ESM packages that Vite cannot handle as external CJS.
- In test configs, provide all required tokens before testing kit-dependent code: `provideKitOverlay(...)`, `provideKitAuth(...)`, `provideKitHttp(...)`.
