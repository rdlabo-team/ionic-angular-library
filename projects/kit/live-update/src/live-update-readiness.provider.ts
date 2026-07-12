import { ApplicationRef, inject, provideEnvironmentInitializer, type EnvironmentProviders } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { LiveUpdate } from '@capawesome/capacitor-live-update';
import { Capacitor } from '@capacitor/core';
import { filter, firstValueFrom, take } from 'rxjs';

/**
 * Marks a native Live Update bundle healthy after Angular is stable and the
 * first route has rendered. Web builds are unaffected.
 */
export function provideLiveUpdateReadiness(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    if (!Capacitor.isNativePlatform()) return;

    const appRef = inject(ApplicationRef);
    const router = inject(Router);
    void Promise.all([
      firstValueFrom(appRef.isStable.pipe(filter(Boolean), take(1))),
      firstValueFrom(
        router.events.pipe(
          filter((event) => event instanceof NavigationEnd),
          take(1),
        ),
      ),
    ])
      .then(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      .then(() => LiveUpdate.ready())
      .catch((error) => console.error('Failed to mark the Live Update bundle as ready.', error));
  });
}
