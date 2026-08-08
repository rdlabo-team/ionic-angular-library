import type { EnvironmentProviders } from '@angular/core';
import {
  ApplicationRef,
  Injectable,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { SwUpdate } from '@angular/service-worker';
import { filter, first } from 'rxjs';

/** Checks for and activates a complete Angular service-worker update when the application starts. */
@Injectable({ providedIn: 'root' })
export class KitAppUpdateService {
  readonly #applicationRef = inject(ApplicationRef);
  readonly #document = inject(DOCUMENT);
  readonly #updates = inject(SwUpdate);
  #started = false;

  /** Starts one non-blocking update check after Angular reports the application as stable. */
  start(): void {
    if (this.#started || !this.#updates.isEnabled) {
      return;
    }
    this.#started = true;
    this.#applicationRef.isStable
      .pipe(
        filter((stable) => stable),
        first(),
      )
      .subscribe(() => void this.#activateUpdate());
  }

  async #activateUpdate(): Promise<void> {
    try {
      if (!(await this.#updates.checkForUpdate())) {
        return;
      }
      await this.#updates.activateUpdate();
      this.#document.location?.reload();
    } catch (error) {
      console.error('Angular service-worker update check failed', error);
    }
  }
}

/** Provides a startup check that activates and reloads into the latest complete web application version. */
export function provideKitAppUpdate(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => inject(KitAppUpdateService).start()),
  ]);
}
