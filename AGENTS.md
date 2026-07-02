# AGENTS.md — ionic-angular-library

## What this repo is

Angular library monorepo that publishes shared Ionic/Angular building blocks to npm. All rdlabo/proschool/odss Ionic Angular applications import from these packages rather than duplicating infrastructure code.

## Published packages

| Directory | npm package | Purpose |
|-----------|-------------|---------|
| `projects/kit` | `@rdlabo/ionic-angular-kit` | Core infrastructure: storage, overlay (modal/toast/alert), HTTP interceptor, auth guards, autofill directive, haptics, array merge utility |
| `projects/scroll-header` | `@rdlabo/ionic-angular-scroll-header` | Scroll-linked header hide/show directives, CDK virtual scroll flicker fix |
| `projects/scroll-strategies` | `@rdlabo/ngx-cdk-scroll-strategies` | Dynamic-size virtual scroll strategy for Angular CDK |
| `projects/photo-editor` | `@rdlabo/ionic-angular-photo-editor` | Image editing/viewing components with filter presets |
| `projects/demo` | *(not published)* | Demo app for testing all libraries |

## @rdlabo/ionic-angular-kit — key exports

### KitStorageService
Typed wrapper around `@ionic/storage-angular`. Auto-initializes via `inject(Storage).create()` in the constructor; every operation awaits the ready Promise internally. No explicit `init()` call needed. API: `set<T>`, `get<T>`, `remove`, `clear`, `keys`.

### KitOverlayController + provideKitOverlay
Wraps Ionic Modal/Toast/Alert controllers. Setup: `provideKitOverlay({ labels: { close, cancel } })`.
- `presentModal<O>(component, componentProps?, options?)` → `Promise<O | undefined>` — supports `watchKeyboard` option for sheet modals
- `presentToast(options)` → `Promise<HTMLIonToastElement>` — returns the toast element (callers can chain `.onDidDismiss()`). Defaults: top, 2000ms, close button, vertical swipe. Triggers haptic feedback.
- `alertClose({ header, message, subHeader? })` → `Promise<void>`
- `alertConfirm({ header, message, okText, subHeader? })` → `Promise<boolean>`

### kitAuthInterceptor + provideKitHttp
Functional HTTP interceptor. Built-in: retry (2x, linear backoff), non-retryable status list `[400, 403, 404, 418, 500, 502]`, `Network.getStatus()` check before calling `onNetworkError`. App provides: `getAuthHeaders`, `buildExtraHeaders`, `onResponse`, `bypass`, `offlineFallback`, `onUnauthorized`, `onForbidden`, `onNetworkError`, `onServerError`.

### Auth guards + provideKitAuth
Functional `CanActivateFn` guards: `kitRequireAuthorizedGuard`, `kitRequiredUnauthorizedGuard`, `kitRequireConfirmingGuard`. App provides: `authState()` → `Observable<'user'|'confirm'|'required'|'anonymous'>`, `onAuthorized`, `onUnauthenticated`, `redirects`.

### KitAutofillDirective
Selector: `[rdlaboAutofill]`. iOS-only workaround for `ion-input` autofill not propagating to Angular form model.

### Utilities
- `kitImpact(style?)` — native haptic feedback, no-op on web
- `arrayConcatById<T>(old, new, key, order='DESC')` — merge paginated lists by key, deduplicate, sort

### Test utilities (projects/util)
- `projects/util/mocks/` — mock factories for NavController, ModalController, PopoverController, IonRouterOutlet
- `projects/util/test.config.ts` — shared vitest/karma configuration

## Consuming projects

| Project | Packages used |
|---------|---------------|
| rdlabo-team/winecode | kit, scroll-header, scroll-strategies, photo-editor |
| rdlabo-team/receptray | scroll-header, scroll-strategies |
| rdlabo-team/tipsys | photo-editor, scroll-header, scroll-strategies |
| rdlabo-team/foodlabel | scroll-header |
| odss-team/odss-mobile | photo-editor, scroll-header |
| proschool-team/airlec2 | *(adoption pending)* |

## Development commands

```bash
npm install
npm run lint          # ng lint (ESLint)
npm run test          # ng test --watch=false (vitest)
npm run prebuild      # build all libraries to dist/
npm run start         # serve demo app (http://localhost:4200/)
```

## Design principles

- **Configuration-injected**: kit services accept configuration via Angular DI (`provideKitOverlay`, `provideKitHttp`, `provideKitAuth`) rather than hard-coding app-specific behavior. The kit ships no i18n strings; the consuming app provides all labels.
- **No NgModules**: all components, directives, and pipes are standalone.
- **Minimal API surface**: each export solves a specific, well-scoped problem. Domain logic and navigation policy belong in the consuming app.
- **Capacitor-aware**: haptics, keyboard, network, and platform checks use `@capacitor/core` and degrade to no-op on web.

## When modifying this repo

1. Run `npm run lint` before committing.
2. Each library has its own `public-api.ts` — new exports must be added there.
3. Every public class, function, and type must have a JSDoc comment.
4. Build all libraries before testing the demo: `npm run prebuild`.
5. The `kit` library (`projects/kit`) must not import from other libraries in this monorepo (scroll-header, photo-editor, etc.) — it is a leaf dependency.
