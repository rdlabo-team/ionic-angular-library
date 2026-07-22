import { computed, Injectable, signal } from '@angular/core';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { Network } from '@capacitor/network';

export type OfflineNetworkState = 'online' | 'offline' | 'unverified';

/** transport不能(status=0)だけをcache fallback対象にし、HTTPエラーは隠さない。 */
export function isOfflineFallbackError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 0;
}

@Injectable({ providedIn: 'root' })
export class OfflineNetworkService {
  readonly #osConnected = signal<boolean | null>(null);
  readonly #apiReachable = signal<boolean | null>(null);
  readonly #listeners: PluginListenerHandle[] = [];
  #initialized = false;

  readonly state = computed<OfflineNetworkState>(() => {
    if (this.#osConnected() === false || this.#apiReachable() === false) return 'offline';
    if (this.#osConnected() === true && this.#apiReachable() === true) return 'online';
    return 'unverified';
  });
  readonly connected = computed(() => this.state() !== 'offline');

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#osConnected.set((await Network.getStatus()).connected);
    this.#listeners.push(
      await Network.addListener('networkStatusChange', ({ connected }) => {
        this.#osConnected.set(connected);
        this.#apiReachable.set(connected ? null : false);
      }),
      await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void this.#refreshOsStatus();
      }),
    );
  }

  markApiSuccess(): void {
    this.#apiReachable.set(true);
  }

  markApiFailure(): void {
    this.#apiReachable.set(false);
  }

  async #refreshOsStatus(): Promise<void> {
    this.#osConnected.set((await Network.getStatus()).connected);
  }
}
