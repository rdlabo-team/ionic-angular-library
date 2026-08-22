# @rdlabo/ionic-angular-kit

`@rdlabo/ionic-angular-kit` provides shared application infrastructure for Ionic Angular applications. It keeps product-specific screens, domain policy, and translations in the consuming app.

```sh
npm install @rdlabo/ionic-angular-kit
```

## Requirements

| Package                            | Supported version |
| ---------------------------------- | ----------------- |
| Angular                            | 21.x–22.x          |
| Ionic Angular                      | 9.x                |
| RxJS                               | 7.8.x             |
| Capacitor core and feature plugins | 7.x–8.x            |
| iOS/iPadOS deployment target       | 16.4 or later      |

Install `@ionic/storage-angular` when using storage. Other peers are feature-scoped: install only the Capacitor, Firebase, printing, or Live Update packages used by your selected entry points.

## Entry points

| Import                                    | Responsibility                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `@rdlabo/ionic-angular-kit`               | Storage, overlays, guards, HTTP, realtime, directives, keyboard, and utilities |
| `@rdlabo/ionic-angular-kit/offline`       | Scoped local replica, outbox, pull, replay, and request policies               |
| `@rdlabo/ionic-angular-kit/theme`         | Persisted light/dark theme and native status bar sync                          |
| `@rdlabo/ionic-angular-kit/review`        | Throttled native in-app review requests                                        |
| `@rdlabo/ionic-angular-kit/printer`       | DOM-to-PNG, Brother label, and PDF helpers                                     |
| `@rdlabo/ionic-angular-kit/auth-firebase` | Firebase dependency wiring and authentication flows                            |
| `@rdlabo/ionic-angular-kit/live-update`   | Capawesome Live Update readiness provider                                      |

Secondary entry points isolate optional native and SDK dependencies from the core bundle.

## Configure only what you use

Most features expose a provider whose callbacks keep routes, copy, credentials, and application side effects outside the kit. Start with [Storage and Overlays](./docs/storage-overlays.md), then add authentication, offline, or native features as your app needs them.

## Documentation

- [Storage and Overlays](./docs/storage-overlays.md)
- [Authentication and HTTP](./docs/auth-http.md)
- [Offline and Realtime](./docs/offline-realtime.md)
- [Optional Features](./docs/optional-features.md)

<!-- rdlabo-docs-omit -->
**Full documentation:** [https://docs.rdlabo.dev/projects/ionic-angular-kit](https://docs.rdlabo.dev/projects/ionic-angular-kit)
<!-- /rdlabo-docs-omit -->
