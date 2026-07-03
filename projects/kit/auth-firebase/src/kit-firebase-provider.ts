import type { EnvironmentProviders } from '@angular/core';
import { InjectionToken, makeEnvironmentProviders } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { FirebaseOptions } from '@angular/fire/app';
import { getApp, initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { Auth, getAuth, indexedDBLocalPersistence, initializeAuth, provideAuth } from '@angular/fire/auth';
import { getAnalytics, provideAnalytics } from '@angular/fire/analytics';
import type { Auth as FirebaseAuth } from 'firebase/auth';

/**
 * DI token for the Firebase `Auth` instance.
 *
 * @remarks
 * Inject this (`inject(KIT_FIREBASE_AUTH)`) instead of `@angular/fire`'s `Auth`, so the
 * `@angular/fire` dependency stays isolated inside the kit. This is the seam that makes the planned
 * `@angular/fire` → `firebase/auth` migration a kit-internal change: only {@link provideKitFirebase}
 * (which binds this token) has to change; every consumer keeps injecting `KIT_FIREBASE_AUTH`.
 *
 * The value is a `firebase/auth` `Auth` (the SDK type is exposed directly, not re-abstracted —
 * Firebase Auth itself is not being dropped, only the `@angular/fire` wrapper).
 */
export const KIT_FIREBASE_AUTH = new InjectionToken<FirebaseAuth>('@rdlabo/ionic-angular-kit:firebase-auth');

/** Configuration for {@link provideKitFirebase}. */
export interface KitFirebaseConfig {
  /** The Firebase project options (`apiKey`, `authDomain`, `projectId`, …). */
  readonly firebaseConfig: FirebaseOptions;
}

/**
 * Wire Firebase App + Auth into the application and bind {@link KIT_FIREBASE_AUTH}.
 *
 * @remarks
 * Replaces each app's hand-rolled `provideFirebaseApp(...)` + `provideAuth(...)` (with its
 * native/web persistence branch) with one call, and — crucially — keeps `@angular/fire` out of the
 * application: apps inject {@link KIT_FIREBASE_AUTH} and import auth operations/types straight from
 * `firebase/auth`. On a native platform the persistence uses `indexedDBLocalPersistence`; on the web
 * it uses the default (`getAuth`).
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [provideKitFirebase({ firebaseConfig: environment.firebase })],
 * });
 * ```
 */
export const provideKitFirebase = (config: KitFirebaseConfig): EnvironmentProviders =>
  makeEnvironmentProviders([
    provideFirebaseApp(() => initializeApp(config.firebaseConfig)),
    provideAuth(() =>
      Capacitor.isNativePlatform()
        ? initializeAuth(getApp(), { persistence: indexedDBLocalPersistence })
        : getAuth(),
    ),
    // Expose @angular/fire's Auth instance under the kit token; phase 3 rebinds this to a
    // firebase/auth instance without touching any consumer.
    { provide: KIT_FIREBASE_AUTH, useExisting: Auth },
  ]);

/**
 * Wire Firebase Analytics into the application (optional; only the apps that use it call this).
 */
export const provideKitFirebaseAnalytics = (): EnvironmentProviders =>
  makeEnvironmentProviders([provideAnalytics(() => getAnalytics())]);
