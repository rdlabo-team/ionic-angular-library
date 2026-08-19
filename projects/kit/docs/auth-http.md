## Access capability

`provideKitAuth()` configures functional route guards for `user`, `confirm`, `required`, `anonymous`, and `unavailable` authentication states. Redirect routes and application side effects remain in the app.

`KitAuthAccessService` publishes what the current session may do:

| Mode     | Local replica and outbox | Authenticated HTTP, realtime, and sync |
| -------- | ------------------------ | -------------------------------------- |
| `none`   | Blocked                  | Blocked                                |
| `local`  | Allowed                  | Blocked                                |
| `remote` | Allowed                  | Allowed                                |

An authoritative `required` result is signed out and must not become offline access. Only an `unavailable` transport result may activate a previously verified local session.

```ts
provideKitAuth(() => ({
  authState: () => inject(AuthService).state$,
  redirects: {
    whenAuthorized: '/home',
    whenConfirming: '/auth/confirm',
    whenNotConfirming: '/auth/signin',
    whenUnauthorized: '/auth',
  },
  isUnavailableError: (error) => isOfflineFallbackError(error),
}));
```

Use `kitRequiredUnauthorizedGuard`, `kitRequireConfirmingGuard`, and `kitRequireAuthorizedGuard` in route definitions. A protected asynchronous decision suspends previously published remote capability until the current authorization lease succeeds.

## HTTP policy

`provideKitHttp()` configures `kitAuthInterceptor` for credential injection, bypass rules, transient failure handling, and application error hooks.

Automatic retry is limited to `GET`, `HEAD`, `OPTIONS`, or requests carrying an `Idempotency-Key`. Ordinary writes are never retried automatically. Retries cover transient statuses `0`, `408`, `429`, `502`, `503`, and `504`, and honor `Retry-After`.

When offline support is enabled, register `offlineInterceptor` before `kitAuthInterceptor`. Local mode then prevents credential generation and network transport while allowing a matched read policy to serve the scoped replica.
