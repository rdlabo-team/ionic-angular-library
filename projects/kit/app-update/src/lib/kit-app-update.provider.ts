import { DOCUMENT } from '@angular/common';
import type { EnvironmentProviders } from '@angular/core';
import { Injectable, inject, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** Checks for a complete Angular service-worker update before users can interact with the application. */
@Injectable({ providedIn: 'root' })
export class KitAppUpdateService {
  readonly #document = inject(DOCUMENT);
  readonly #updates = inject(SwUpdate);
  #initialization: Promise<void> | null = null;

  /** Runs one startup update check and reloads directly into a downloaded version when one is available. */
  initialize(): Promise<void> {
    this.#initialization ??= this.#initialize();
    return this.#initialization;
  }

  async #initialize(): Promise<void> {
    if (!this.#updates.isEnabled || !this.#document.defaultView?.navigator.serviceWorker?.controller) {
      return;
    }
    try {
      const available = await withTimeout(this.#updates.checkForUpdate(), UPDATE_CHECK_TIMEOUT_MS);
      if (available) {
        this.#document.location?.reload();
      }
    } catch (error) {
      console.error('Angular service-worker update check failed', error);
    }
  }
}

/**
 * Provides a startup check that reloads into the latest complete web application version.
 *
 * @remarks
 * The check finishes before application bootstrap so a delayed update cannot discard user input. It times out rather
 * than preventing offline startup. API deployments must remain backward compatible while a newly adopted updater is
 * rolling out because code already running in older application versions cannot gain this behavior retroactively.
 */
export function provideKitAppUpdate(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => inject(KitAppUpdateService).initialize()),
  ]);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => resolve(undefined), timeoutMs);
    void promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
