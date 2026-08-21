# Migration guide

## Angular 21–22 and Ionic 9

The 21.x package line supports Angular 21 and 22 with Ionic 9. Ionic 9 requires Angular 18 or later; native applications also require Capacitor 7 or later.

Read the upstream [Ionic 9 breaking changes](https://github.com/ionic-team/ionic-framework/blob/main/BREAKING.md#version-9x) and the [Angular version compatibility table](https://angular.dev/reference/versions) before upgrading your application.

### 1. Update dependencies

Use matching Angular major versions throughout the application. Angular 22 uses TypeScript 6.0 and requires a supported Node.js release.

```bash
npx ng update @angular/core@22 @angular/cli@22
npx @ionic/migrate
```

`@ionic/migrate` is the recommended path for Ionic applications: it updates the Ionic packages and applies the available source migrations. Review its changes together with the manual audit below. The migrator does not support Angular library workspaces such as this repository, so library maintainers must apply the Ionic changes manually.

For a native application, upgrade Capacitor separately and follow its migration guide:

```bash
npm install @capacitor/core@^8 @capacitor/ios@^8 @capacitor/android@^8
npm install --save-dev @capacitor/cli@^8
npx cap migrate
```

Capacitor 7 and 8 are supported by these libraries. Keep all Capacitor core and plugin packages on compatible major versions.

### 2. Update Ionic Angular imports

Ionic 9 exports standalone components and providers from `@ionic/angular` by default. Replace imports from the old standalone entry point:

```ts
// Before
import { IonContent, ModalController, provideIonicAngular } from '@ionic/angular/standalone';

// After
import { IonContent, ModalController, provideIonicAngular } from '@ionic/angular';
```

If the application intentionally uses lazy-loaded Ionic wrappers, import those wrappers from `@ionic/angular/lazy`. `IonicModule` still works in Ionic 9 but is deprecated; new and migrated applications should use `provideIonicAngular()`.

### 3. Check change detection

Angular 21 is zoneless by default. Angular 22 additionally defaults components without an explicit strategy to `OnPush`.

Prefer signals for state changed after asynchronous work such as overlay dismissal, timers, RxJS subscriptions, or platform events. Otherwise call `ChangeDetectorRef.markForCheck()`. Run the Angular update migrations so existing components retain their intended change-detection behavior.

### 4. Audit Ionic 9 component changes

Check application templates, styles, and tests for the following Ionic 9 changes:

- Replace `autocorrect="on"` or `autocorrect="off"` on `ion-input` and `ion-searchbar` with a boolean property binding, or omit it for the default `false` value.
- Replace legacy picker components and controller APIs with the inline `ion-picker` component.
- Set `handleBehavior="none"` on sheet modals only when the handle must retain its previous inert behavior; the new default is `cycle`.
- Use `ion-router-outlet` for URL-based routing. `ion-nav` now manages only an imperative, URL-less navigation stack.
- Do not rely on `ion-select` emitting `ionChange` when a confirmed value did not change. Use dismissal events when confirmation itself matters.
- Review custom selectors and shadow-part styles for `ion-input`, `ion-select`, and `ion-textarea`, whose internal structures changed.
- Review Material Design textarea layouts: the new minimum height is 72px.

### 5. Verify the application

Build and test both web and native targets after updating:

```bash
npm run lint
npm test
npm run build
npx cap sync
```

Test modal sheets, form controls, select overlays, virtual scrolling, navigation gestures, and state updates that occur after asynchronous callbacks on each supported platform.
