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
| `@capacitor/keyboard` | `>=6.0.0 <9.0.0` |
| `@capacitor/network` | `>=6.0.0 <9.0.0` |
| `rxjs` | `^7.8.0` |

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
    const result = await this.#overlay.presentModal<{ id: number }>(DetailPage, { item });
    // result is the data passed to modal.dismiss()
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
presentModal<O>(
  component: ModalOptions['component'],
  componentProps?: ModalOptions['componentProps'],
  options?: KitModalPresentOptions,   // Omit<ModalOptions, 'component'|'componentProps'> + watchKeyboard?
): Promise<O | undefined>

presentToast(options: ToastOptions): Promise<HTMLIonToastElement>
// kit defaults: position='top', duration=2000, swipeGesture='vertical'
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

---

### Auth guards + provideKitAuth

Functional `CanActivateFn` guards for a four-state auth model:

| State | Meaning |
|---|---|
| `'user'` | Fully authenticated |
| `'confirm'` | Authenticated but email confirmation pending |
| `'required'` | Not authenticated |
| `'anonymous'` | Anonymous login active (can be prompted to register) |

**Convention:** every redirect path and every app-specific hook (`onAuthorized`, `onUnauthenticated`) is supplied via `provideKitAuth`. The kit does not hard-code any routes.

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
        onAuthorized: async (state) => {
          // Called for 'user' — perform token refresh, permission check, etc.
          // Return true to proceed, UrlTree to redirect, false to block.
          await auth.refreshToken();
          return true;
        },
        onUnauthenticated: async (state) => {
          // Called for 'required'/'confirm' in kitRequireAuthorizedGuard.
          // Return true to allow anonymous access, false to redirect.
          return false;
        },
        redirects: {
          whenAuthorized: '/home',          // kitRequiredUnauthorizedGuard
          whenConfirming: '/auth/confirm',  // kitRequiredUnauthorizedGuard
          whenNotConfirming: '/auth/signin',// kitRequireConfirmingGuard
          whenUnauthorized: '/auth',        // kitRequireAuthorizedGuard
        },
      };
    }),
  ],
};
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
- Exponential-backoff retry (count: 2) skipping `[400, 403, 404, 418, 500, 502]` and `401`
- Offline fallback (short-circuit error with a cached response)
- Error hooks for 401, 403, network errors, and server errors with `error.message`

**Convention:** all app-specific logic (auth headers, error UI) lives in the config factory. The retry policy, bypass evaluation, and error dispatch are fixed in the kit and not overridable per-call.

**Setup**

```typescript
// app.config.ts
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { kitAuthInterceptor, provideKitHttp } from '@rdlabo/ionic-angular-kit';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([kitAuthInterceptor])),
    provideKitHttp(() => {
      const auth = inject(AuthService);
      const router = inject(Router);
      const toast = inject(KitOverlayController);
      return {
        bypass: (req) => req.url.startsWith('https://cdn.example.com'),
        getAuthHeaders: async (req) => ({
          Authorization: `Bearer ${await auth.getToken()}`,
        }),
        buildExtraHeaders: (req) => ({ 'X-App-Version': '1.0.0' }),
        offlineFallback: (req, err) => null,   // no offline queue
        onUnauthorized: (req) => auth.signOut(),
        onForbidden: (req) => router.navigate(['/403']),
        onNetworkError: (status) => toast.presentToast({ message: 'Network error' }),
        onServerError: (message) => toast.presentToast({ message }),
      };
    }),
  ],
};
```

**Error dispatch order** (in `catchError`):
1. `offlineFallback` non-null → return fallback observable (no further hooks called)
2. `401` → `onUnauthorized`
3. `403` → `onForbidden`
4. Non-400/500 status AND device connected → `onNetworkError`
5. 400 or 500 with `error.message` → `onServerError`

---

### KitAutofillDirective

An iOS workaround for `ion-input` autofill (password managers, iCloud Keychain). Without it, autofilled values are not reflected in the Angular form model on iOS native.

```html
<ion-input rdlaboAutofill formControlName="password" type="password" />
```

The directive is a no-op on non-iOS platforms.

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
