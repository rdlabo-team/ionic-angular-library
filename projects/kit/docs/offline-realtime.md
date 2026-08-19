## Scoped offline runtime

The `/offline` entry point provides a user- and partition-scoped local replica, durable outbox, cursor-based delta pull, aggregate-ordered replay, optimistic mutation policies, and request-policy interception.

Use `mode: 'readCacheOnly'` for external-source or HTTP caches. Synchronized mode uses encrypted `@capacitor-community/sqlite` on iOS and Android; it fails fast on the web because the current runtime has no cross-tab synchronization lock.

Cold-start offline access restores only a manifest bound to a non-null authentication-provider subject. Remote work follows this order:

1. Prepare the verified remote session.
2. Publish `remote` access.
3. Resume pull, outbox replay, and realtime work.

`createOfflineAuthBridge()` connects this ordering to `provideKitAuth()` while leaving consent, error UI, and credential exchange in the app.

```ts
import { createOfflineAuthBridge, isOfflineFallbackError } from '@rdlabo/ionic-angular-kit/offline';

provideKitAuth(() => ({
  authState: () => auth.state$,
  ...createOfflineAuthBridge({
    exchange: async (context) => exchangeCredential(context),
    currentAuthSubject: () => auth.currentSubject(),
    isUnavailableError,
    availability: () => auth.authorityAvailable$,
  }),
  redirects,
}));
```

On explicit sign-out, clear `KitAuthAccessService` first, then await offline session cleanup so in-flight leases are invalidated before persisted user data is removed.

## Realtime connection

Subclass `KitRealtimeConnection` to supply connection intent and `{ url, protocols }` targets. The kit owns foreground and network suspension, target-scoped reconnect, exponential backoff, ping/pong detection, self-echo annotation, and `reconnected$` resync signaling.

Use `kitRealtimeProtocols()` to carry authentication and the stable `KIT_REALTIME_CLIENT_ID` in WebSocket subprotocols instead of URL parameters. Offline-capable authenticated clients set `requireRemoteAccess: true`; sockets then remain closed in `none` and `local` modes.
