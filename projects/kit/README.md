# @rdlabo/ionic-angular-kit

A small ergonomic kit for Ionic Angular applications. It provides:

- **KitStorageService** — a typed, write-loss-safe wrapper around `@ionic/storage-angular`
- **KitOverlayController** — a unified presenter for Ionic Modal, Toast, and Alert
- **Auth guards** — functional `CanActivateFn` guards for a 4-state auth model
- **HTTP interceptor** — a fleet-canonical auth + retry + error-hook interceptor
- **KitRealtimeConnection** — foreground/network-aware Hibernation WebSocket reconnect and resync
- **KitAuthInputDirective** — sign-in email remember/prefill + iOS autofill workaround for `ion-input`
- **kitClearStoragePreservingKeys** — `clear()` that restores selected keys (`KIT_LAST_AUTH_EMAIL_KEY`, `KIT_THEME_STORAGE_KEY`, …)

---

## Install

```bash
npm install @rdlabo/ionic-angular-kit
# prereleases (np: X.Y.Z-N) are on the npm dist-tag `beta`:
# npm install @rdlabo/ionic-angular-kit@beta
```

Kit shares the repo `v*` release line with the other libraries (see root README § Release).

### Peer dependencies

| Package                              | Version          |
| ------------------------------------ | ---------------- |
| `@angular/common`                    | `^21.0.0`        |
| `@angular/core`                      | `^21.0.0`        |
| `@angular/router`                    | `^21.0.0`        |
| `@ionic/angular`                     | `^8.0.0`         |
| `@ionic/storage-angular`             | `^4.0.0`         |
| `@capacitor/core`                    | `>=6.0.0 <9.0.0` |
| `@capacitor/app`                     | `>=6.0.0 <9.0.0` |
| `@capacitor/haptics`                 | `>=6.0.0 <9.0.0` |
| `@capacitor/keyboard`                | `>=6.0.0 <9.0.0` |
| `@capacitor/network`                 | `>=6.0.0 <9.0.0` |
| `@capacitor/preferences`             | `>=6.0.0 <9.0.0` |
| `@capacitor/status-bar`              | `>=6.0.0 <9.0.0` |
| `@capacitor-community/in-app-review` | `>=6.0.0 <9.0.0` |
| `@rdlabo/capacitor-brotherprint`     | `>=6.0.0 <9.0.0` |
| `dom-to-image-more`                  | `^3.0.0`         |
| `rxjs`                               | `^7.8.0`         |

Feature-scoped peers are only needed by the features that use them (`status-bar` → `KitThemeController`; `preferences` + `in-app-review` → `kitRequestReview`; `capacitor-brotherprint` + `dom-to-image-more` → the Brother/PNG printer helpers; `pdf-lib` → the PDF printer helper); an app that doesn't use a feature can ignore its unmet-peer warning.

---

## Features

### KitRealtimeConnection

An abstract Hibernation WebSocket client for application realtime services. Subclasses supply
connection intent and one or more `{ url, protocols }` targets; the kit owns foreground/network
suspension, target-scoped reconnect that preserves healthy sockets, exponential backoff, open and half-open detection, ping/pong,
self-echo annotation, and `reconnected$` resync signaling. Use `kitRealtimeProtocols()` to pass
authentication and the stable `KIT_REALTIME_CLIENT_ID` through WebSocket subprotocols without
putting credentials in the URL.

Domain event types, authorization, room selection, and REST resync behavior remain in the app.

---

### KitStorageService

A typed wrapper around `@ionic/storage-angular` that guarantees writes are never silently dropped even when called immediately after service creation.

**How it works:** `Storage.create()` is awaited exactly once internally (via a private `#ready` promise). Every public method awaits `#ready` before operating, so callers never need a separate init step.

**Setup** — provide `IonicStorageModule` (or equivalent) alongside the service:

```typescript
// app.config.ts
import { IonicStorageModule } from '@ionic/storage-angular';
import { importProvidersFrom } from '@angular/core';

export const appConfig: ApplicationConfig = {
  providers: [importProvidersFrom(IonicStorageModule.withConfig({ name: '__mydb' }))],
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
// A bottom toast with no explicit positionAnchor auto-anchors above a visible bottom <ion-tab-bar>
// (`slot="top"` bars are ignored) so it clears the tabs; keyboard avoidance rides the native keyboard resize.
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

**How `presentModal` decides required vs. optional props.** Props are inferred from the component's `input()` fields, and whether each prop is **required** or **optional** is decided by a single rule: _does the input's type include `undefined`?_ A default value is not "optional" — providing a default removes `undefined` from the input's type, so a defaulted input becomes a **required** prop.

| Declaration              | Input type       | Includes `undefined`? | Prop                                       |
| ------------------------ | ---------------- | --------------------- | ------------------------------------------ |
| `input.required<T>()`    | `T`              | No                    | required                                   |
| `input<T>(defaultValue)` | `T`              | No                    | **required** ← a default makes it required |
| `input<T>()` (no arg)    | `T \| undefined` | Yes                   | optional                                   |

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

| State         | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| `'user'`      | Fully authenticated                                  |
| `'confirm'`   | Authenticated but email confirmation pending         |
| `'required'`  | Not authenticated                                    |
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
        authState: () => auth.state$, // Observable<KitAuthState>
        redirects: {
          whenAuthorized: '/home', // kitRequiredUnauthorizedGuard
          whenConfirming: '/auth/confirm', // kitRequiredUnauthorizedGuard
          whenNotConfirming: '/auth/signin', // kitRequireConfirmingGuard
          whenUnauthorized: '/auth', // kitRequireAuthorizedGuard
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
import { kitRequiredUnauthorizedGuard, kitRequireConfirmingGuard, kitRequireAuthorizedGuard } from '@rdlabo/ionic-angular-kit';

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

### Scoped local replica and outbox (`@rdlabo/ionic-angular-kit/offline`)

The optional `offline` entry point provides a user/group-scoped local replica, durable outbox, authenticated
session boundary, cursor-based delta pull, aggregate-ordered replay, optimistic updates, retry classification, and a
read-only request-policy interceptor. Applications provide URL/DTO read policies, a replica puller, and a command
executor through `provideOffline(...)`.
Mutations are queued explicitly with `OfflineSyncService.enqueue`, not through HTTP interceptor policy.
Web storage uses Ionic Storage; iOS and Android use encrypted Capawesome SQLite. Importing either the
primary entry point or `/offline` does not pull the private plugin into existing applications.

The offline interceptor observes real transport responses to update API reachability. For matched `GET`
requests only, a transport failure with `status=0` may return a local replica response tagged
`X-Offline-Response: local`. `POST` and other write methods always go to transport unchanged; outbox replay
requests bypass policy with `OFFLINE_BYPASS` while still using the same transport observation.

Native applications install the Insiders package in the application, then pass its `Sqlite` export
and an encryption key loaded from secure device storage to the kit:

```bash
npm install @capawesome-team/capacitor-sqlite
```

```ts
provideOffline({
  // ...product policies, puller, and executor
  sqlitePlugin: Sqlite,
  encryptionKey: async () => {
    const { value } = await securePreferences.get({ key: 'offline-database-key' });
    if (!value) throw new Error('offline-database-key is missing');
    return value;
  },
});
```

SQLite entities use an immutable client-generated UUID as `localId` and keep the server's
`AUTO_INCREMENT` id separately as nullable `serverId`. The outbox references only `aggregateLocalId`.
Immediately before each send, the executor receives the latest `{ localId, serverId }` resolved from
SQLite; a successful create adds `serverId` without replacing `localId`. Entity projection and outbox
append/removal are committed in one local transaction.

Each synchronization cycle pulls authoritative server deltas before replaying the outbox. Every page carries the
replica schema version/hash and advances a durable user/group cursor in the same transaction as its rows. A schema
mismatch, malformed row, or non-advancing cursor rejects synchronization without advancing that cursor. If a remote
revision changed while a local command is pending, the optimistic row remains visible and both row and command move
to `conflict`; the new server value is retained as the confirmed baseline.

Versioned replica schemas lock web and native storage. Web metadata stores
`replicaSchemaVersion` and `replicaSchemaHash`; native stores the same pair in
`offline_replica_schema_metadata`. Bump `version` for every intentional shape change and supply a
complete one-step migration chain. Native runs each step's SQL `statements`; web runs
`migrateWebRow`, which receives only `{ sourceKey, values, confirmedValues }` and may return the same
shape or `null` to delete a row. Identity and sync metadata (`localId`, `serverId`, scope, revision,
`syncState`) stay outside the callback. The bundle fingerprint hashes `version`, entity layouts, and
migration `fromVersion`/`statements` — never function bodies.

```typescript
import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  provideOffline,
  serverId,
  text,
} from '@rdlabo/ionic-angular-kit/offline';

// This is the Hono package's existing `typeof items.$inferSelect` export.
import type { Items as ItemSelect } from '@product/hono/db/schema';

const itemEntityV2 = defineReplicaEntity<ItemSelect>()({
  table: 'items',
  sourceKey: 'items',
  scope: 'group',
  fields: {
    id: serverId(),
    title: text(),
    subtitle: text(),
  },
});

const replicaSchema = defineOfflineReplicaSchema({
  version: 2,
  entities: [itemEntityV2],
  migrations: [
    {
      fromVersion: 1,
      statements: ['ALTER TABLE items ADD COLUMN subtitle TEXT NOT NULL DEFAULT ""'],
      migrateWebRow: (row) => ({
        sourceKey: row.sourceKey,
        values: { ...row.values, subtitle: '' },
        confirmedValues:
          row.confirmedValues === null ? null : { ...row.confirmedValues, subtitle: '' },
      }),
    },
  ],
});

provideOffline({
  replicaSchema,
  replicaPuller: ProductReplicaPuller,
  commandExecutor: ProductCommandExecutor,
  // ...request policies, sqlitePlugin, encryptionKey
});
```

The schema definition must map every `ItemSelect` key exactly once as a SQLite column, `serverId()`, or
`ignored(reason)`. Nullable Hono columns require `nullable(...)`; non-null columns reject it. Therefore adding,
removing, or changing nullability of a Drizzle column breaks the app build until its replica mapping is updated.
At runtime, `values` contains only the mapped column projection; `localId` and `serverId` remain dedicated replica
fields and ignored server fields are never persisted.

Encrypted native builds also require the plugin's SQLCipher platform setup: enable
`capawesomeCapacitorSqliteIncludeSqlcipher = true` on Android; select the `SQLCipher` pod when using
CocoaPods, or enable the `SQLCipher` package trait when using Swift Package Manager on iOS. Follow
the [Capawesome SQLite installation guide](https://capawesome.io/docs/plugins/sqlite/#installation)
for the exact native configuration and export-compliance notes.

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

### KitAuthInputDirective (`kitAuthInput`)

Sign-in / sign-up conveniences on `ion-input`:

- `'email'` — remember + prefill the last well-formed address (and forget when the user clears it)
- `'email-remember'` — remember on change only (no prefill — use on sign-up)
- `'autofill'` — iOS autofill propagation only (password fields)

```html
<ion-input type="email" autocomplete="email" kitAuthInput="email" [formField]="form.email" />
```

### kitClearStoragePreservingKeys

Fleet apps typically `storage.clear()` on sign-out. Pass keys that must survive (e.g. the last sign-in email):

```typescript
import { KIT_LAST_AUTH_EMAIL_KEY, KIT_THEME_STORAGE_KEY, kitClearStoragePreservingKeys } from '@rdlabo/ionic-angular-kit';

await kitSignOut(auth, {
  success: () => kitClearStoragePreservingKeys(this.storage, [KIT_LAST_AUTH_EMAIL_KEY, KIT_THEME_STORAGE_KEY]),
});
```

It snapshots the listed keys, clears the store, then writes non-null values back.

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
  locales: [
    { text: 'English', data: 'en-US' },
    { text: '日本語', data: 'ja' },
  ],
  cancelText: $localize`キャンセル`,
  currentLocale: normalizedLocale,
  currentPath: this.#router.url,
  pathnameStorageKey: StorageKeyEnum.pathnameBeforeRedirect,
  buildRedirectUrl: (locale) => location.origin + (localePath[locale.toLowerCase()] ?? '/index.html'),
  enabled: environment.production,
});
```

---

### Printer (label image and PDF plumbing)

Pure functions (no DI) that extract the i18n-free core of the fleet's label printing, so a device-quirk, layout, or PDF fix lands in every app at once. The UI orchestration — paper-selection alerts, loading overlays, storage, printer transport, and app-specific copies policy — stays in each app.

- `kitDomToPng(element, { rotate?, scale? })` — render a DOM element to a base64 PNG with the fleet's device fixes (iOS +2px to avoid bottom clipping, none on Android to avoid a black line; retries up to 10×). The caller presents its own loading UI.
- `kitRotationImage(base64)` — rotate a base64 image 90° via canvas.
- `kitBuildBrotherPrintSettings({ modelName, printBase64, label, numberOfCopies, halftoneThreshold })` — assemble the canonical `BRLMPrintOptions` (fit-page, centered, best quality, threshold halftone, standard margins, tape size parsed from the label's `W<w>H<h>` code). Merge `{ port, channelInfo }` from the selected channel before calling `BrotherPrint.printImage()`.
- `kitCalculatePrintLayout({ paper, labelWidthPx, labelHeightPx, copies, measure?, marginMm? })` — calculate row-major positions across as many pages as required. The default outer margin is 5mm.
- `kitBuildLabelPdf({ imageData, ...layoutOptions })` — embed the PNG artwork at the calculated positions and return PDF bytes. It deliberately does not open a browser tab or call a native printer.
- `kitPrintPaperSizes` — A4/B5 presets. Callers may pass any other `KitPrintPaper` dimensions without changing the kit.

```typescript
import { kitBuildBrotherPrintSettings, kitBuildLabelPdf, kitDomToPng, kitPrintPaperSizes } from '@rdlabo/ionic-angular-kit/printer';

const png = await kitDomToPng(this.preview().nativeElement, { rotate: true });
const settings = kitBuildBrotherPrintSettings({
  modelName,
  printBase64: png,
  label,
  numberOfCopies: printOptions.printNum,
  halftoneThreshold: printOptions.halftoneThreshold,
});
await BrotherPrint.printImage({ ...settings, port: channel.port, channelInfo: channel.channelInfo });

const pdfBytes = await kitBuildLabelPdf({
  imageData: png,
  paper: kitPrintPaperSizes.a4,
  labelWidthPx: 200,
  labelHeightPx: 100,
  copies: 6,
  marginMm: 5,
});
```

---

### Firebase auth (`@rdlabo/ionic-angular-kit/auth-firebase`)

A secondary entry point so only apps that use it pull in `firebase` (declared as an optional peer dependency — install `firebase` in the app). It exists to **isolate the Firebase SDK**: `firebase/auth` is initialized in exactly one place — the DI provider — so apps import `KIT_FIREBASE_AUTH` and call these functions, never wiring `firebase/auth` themselves. The kit uses the vanilla modular `firebase/auth` SDK directly (no `@angular/fire`).

**Design principle: the kit performs no UI.** Every function runs the Firebase operation and nothing else; loading overlays, prompts and error alerts are app side effects. The flow functions take the uniform lifecycle hooks `{ before, success, error, finally }` and, rather than throwing, resolve value flows to `null` and boolean flows to `false`, handing the raw error to the `error` hook so the app presents it from its own dictionary. For anything the functions don't express, drop down to `firebase/auth` directly.

```typescript
// app.config.ts — Firebase is initialized only here
provideKitFirebase({ firebaseConfig: environment.firebase }),
provideKitFirebaseAnalytics(),
```

```typescript
import { inject, Injectable } from '@angular/core';
import {
  KIT_FIREBASE_AUTH,
  kitSignIn,
  kitSignOut,
  kitResolveAuthStatus,
  kitReauthWithRetry,
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

### Live Update (`@rdlabo/ionic-angular-kit/live-update`)

A secondary entry point (so only apps that use it pull in `@capawesome/capacitor-live-update`, declared as an optional peer) for shipping [Capawesome Live Updates](https://capawesome.io/plugins/live-update/) — over-the-air replacement of the Web (Angular/Ionic) layer without a store review.

#### `provideLiveUpdateReadiness()`

Marks the running Live Update bundle **healthy** once the app has actually rendered, so Capawesome does not auto-roll-back a good bundle. It waits for Angular to become stable **and** the first route to finish (`NavigationEnd` + one animation frame) before calling `LiveUpdate.ready()`. This replaces a fixed `readyTimeout` in `capacitor.config.ts` with a signal tied to real readiness. **Native only** — a no-op on web.

```typescript
// app.config.ts
import { provideLiveUpdateReadiness } from '@rdlabo/ionic-angular-kit/live-update';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideLiveUpdateReadiness(),
    // ...
  ],
};
```

#### Release and channel model

Each app's release workflow runs when a `vX.Y.Z` or `vX.Y.Z-N` tag is pushed. The shared `classify-mobile-release` composite action in [`ionic-angular-library/.github/actions`](https://github.com/rdlabo-team/ionic-angular-library/tree/main/.github/actions) compares the tag with the previous release and selects the delivery path. Patch and prerelease updates within the same `major.minor` line use `publish-live-update`; major and minor updates use Capawesome Cloud Native Builds and App Store Publishing.

Every delivery channel is named **`production-<native-build-number>`**, where the Android `versionCode` and iOS `CURRENT_PROJECT_VERSION` must match. A Live Update replaces only the JS, HTML, and CSS on an existing native binary, so channels are isolated by build number and updates reach only compatible devices. The upload pins `--android-min/max` and `--ios-min/max` to that build number.

- **Same channel: eligible for Live Update**
  Keep the native build number unchanged. This path is for JS, HTML, and CSS changes only, including bug fixes, copy, UI, application logic, and npm dependencies that do not affect native code. Incrementing only the patch version within the same `major.minor` line keeps the channel unchanged, so existing users receive the update without installing a new store build.
  Example: `9.0.0` (build `9000000`) followed by a web-only `9.0.1` update; both use `production-9000000`.

- **New channel: store release required**
  Increment the major or minor version and the native build number. Include changes to `app/android/**`, `app/ios/**`, `capacitor.config.ts` (or `.json`), and Capacitor plugin versions in this release type. The workflow submits iOS builds to TestFlight and Android builds to the Google Play Internal track; promotion to production happens in each store.
  Example: a native update to `9.1.0` (build `9010000`) creates `production-9010000`. Devices still running `9.0.x` remain on `production-9000000` and are unaffected.

The build number encodes the major and minor versions at the front: `floor(buildNumber / 10000) === major * 100 + minor`.

| Version  | Build number | Channel               |
| -------- | ------------ | --------------------- |
| `9.0.x`  | `9000000`    | `production-9000000`  |
| `9.1.x`  | `9010000`    | `production-9010000`  |
| `10.2.x` | `10020000`   | `production-10020000` |

`classify-mobile-release` fails CI when a patch or prerelease contains native, configuration, or Capacitor dependency changes and requires a major or minor bump instead. For store releases, it verifies that the tag matches the native marketing version, the Android and iOS versions and build numbers agree, the build number increases, and the encoding above is valid. `validate-live-update` remains available for compatibility with existing consumers.

---

## Consumer Vitest setup notes

When testing a consumer app that declares `@rdlabo/ionic-angular-kit` as a `file:` symlink dependency, add the following to your `vitest.config.ts`:

```typescript
// vitest.config.ts
export default defineConfig({
  resolve: {
    dedupe: ['@angular/core', '@angular/common', '@angular/router', '@ionic/angular', '@ionic/core', 'rxjs'],
  },
  test: {
    server: {
      deps: {
        inline: [
          /@ionic\/angular/,
          /@ionic\/core/,
          /ionicons/,
          /@rdlabo\/ionic-angular-kit/, // inline the kit itself
        ],
      },
    },
  },
});
```

- `resolve.dedupe` prevents Angular's `inject()` from throwing `NG0203 (must be called in an injection context)` when the symlinked kit resolves a different copy of `@angular/core`.
- `server.deps.inline` is required for ESM packages that Vite cannot handle as external CJS.
- In test configs, provide all required tokens before testing kit-dependent code: `provideKitOverlay(...)`, `provideKitAuth(...)`, `provideKitHttp(...)`.
