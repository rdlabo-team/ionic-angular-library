import type { EnvironmentProviders } from '@angular/core';
import { InjectionToken, makeEnvironmentProviders } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import { getApp, getApps, initializeApp } from 'firebase/app';
import type { Auth as FirebaseAuth } from 'firebase/auth';
import { getAuth, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth';
import { getAnalytics } from 'firebase/analytics';

/**
 * DI token for the Firebase `Auth` instance.
 *
 * @remarks
 * Inject this (`inject(KIT_FIREBASE_AUTH)`) instead of importing `getAuth()` in the app, so the
 * Firebase SDK wiring stays isolated inside the kit: only {@link provideKitFirebase} (which binds
 * this token) touches initialization; every consumer keeps injecting `KIT_FIREBASE_AUTH`.
 *
 * The value is a `firebase/auth` `Auth` — the SDK type is exposed directly, not re-abstracted.
 */
export const KIT_FIREBASE_AUTH = new InjectionToken<FirebaseAuth>('@rdlabo/ionic-angular-kit:firebase-auth');

/** Configuration for {@link provideKitFirebase}. */
export interface KitFirebaseConfig {
  /** The Firebase project options (`apiKey`, `authDomain`, `projectId`, …). */
  readonly firebaseConfig: FirebaseOptions;
}

/** Initialize (or reuse) the Firebase app for the kit's config. */
const kitFirebaseApp = (config: KitFirebaseConfig): FirebaseApp => (getApps().length ? getApp() : initializeApp(config.firebaseConfig));

/**
 * Wire Firebase App + Auth into the application and bind {@link KIT_FIREBASE_AUTH}.
 *
 * @remarks
 * Replaces each app's hand-rolled `provideFirebaseApp(...)` + `provideAuth(...)` with one call.
 * Firebase is initialized eagerly with the vanilla `firebase/app` + `firebase/auth` SDK (no
 * `@angular/fire`), and the resulting `Auth` is bound to {@link KIT_FIREBASE_AUTH}. On a native
 * platform the persistence uses `indexedDBLocalPersistence`; on the web it uses the default
 * (`getAuth`). Apps inject {@link KIT_FIREBASE_AUTH} and call the kit's flow functions, keeping the
 * Firebase SDK isolated inside the kit.
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [provideKitFirebase({ firebaseConfig: environment.firebase })],
 * });
 * ```
 */
export const provideKitFirebase = (config: KitFirebaseConfig): EnvironmentProviders => {
  const app = kitFirebaseApp(config);
  const auth = Capacitor.isNativePlatform() ? initializeAuth(app, { persistence: indexedDBLocalPersistence }) : getAuth(app);
  return makeEnvironmentProviders([{ provide: KIT_FIREBASE_AUTH, useValue: auth }]);
};

/**
 * Wire Firebase Analytics into the application (optional; only the apps that use it call this).
 *
 * @remarks
 * Analytics is initialized eagerly against the already-initialized Firebase app, so this must be
 * called after (or alongside) {@link provideKitFirebase}.
 */
export const provideKitFirebaseAnalytics = (): EnvironmentProviders => {
  getAnalytics(getApp());
  return makeEnvironmentProviders([]);
};
