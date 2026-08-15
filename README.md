These libraries is a collection of components and services that are useful for developing Ionic Angular applications.

Documentation: [Ionic Angular Kit](https://docs.rdlabo.dev/projects/ionic-angular-kit) · [Photo Editor](https://docs.rdlabo.dev/projects/ionic-angular-photo-editor) · [Scroll Header](https://docs.rdlabo.dev/projects/ionic-angular-scroll-header) · [Scroll Strategies](https://docs.rdlabo.dev/projects/ngx-cdk-scroll-strategies)

[Demo site is here.](https://rdlabo-ionic-angular-library.netlify.app/)

## Support Version

| Angular | Package version |
| ------- | --------------- |
| v20     | 20.x.x          |
| v19     | 19.x.x          |
| v18     | 2.x.x           |

## packages

| package name                        | description                                                                                | path                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| @rdlabo/ionic-angular-kit           | Auth guards, Firebase flows, storage, overlay, HTTP interceptor, and other fleet helpers.  | [/projects/kit](https://github.com/rdlabo-dev/ionic-angular-library/tree/main/projects/kit#readme)                            |
| @rdlabo/ionic-angular-photo-editor  | This is a photo editor and viewer for modal page of Ionic Angular project using Capacitor. | [/project/photo-editor](https://github.com/rdlabo-dev/ionic-angular-library/tree/main/projects/photo-editor#readme)           |
| @rdlabo/ionic-angular-scroll-header | This is directive for scroll with Header.                                                  | [/project/scroll-header](https://github.com/rdlabo-dev/ionic-angular-library/tree/main/projects/scroll-header#readme)         |
| @rdlabo/ngx-cdk-scroll-strategies   | This is directive for virtual scroll of dynamic item size.                                 | [/project/scroll-strategies](https://github.com/rdlabo-dev/ionic-angular-library/tree/main/projects/scroll-strategies#readme) |

### Release

All libraries (including kit) share one version line and are released together via `npm run release` (`np --no-tests --no-publish`) → `v*` tag → GitHub Actions `release.yml`.

- Stable `vX.Y.Z` → npm `latest`
- Prerelease `vX.Y.Z-N` (np style) → npm dist-tag **`beta`** (version string stays `X.Y.Z-N`)

### Kit Auth demo

The demo app includes a **Kit** tab with a Firebase Auth harness (`/main/kit/auth`).

1. Fill `projects/demo/src/environments/environment.ts` (`firebase`).
2. `npm start` — open the Kit tab.
3. `npm run e2e` — Playwright signs up with a UUID email; `window.__E2E__` skips email confirmation.
4. `npm run cap` — copy a production build to iOS/Android for device checks (e.g. `kitAuthInput` autofill).
