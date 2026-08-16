import { computed, Injectable, signal } from '@angular/core';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { Network } from '@capacitor/network';

export type OfflineNetworkState = 'online' | 'offline' | 'unverified';

/** transport不能(status=0)だけをlocal replica fallback対象にし、HTTPエラーは隠さない。 */
export function isOfflineFallbackError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 0;
}

/** Combines operating-system connectivity with observed API reachability. */
@Injectable({ providedIn: 'root' })
export class OfflineNetworkService {
  readonly #osConnected = signal<boolean | null>(null);
  readonly #apiReachable = signal<boolean | null>(null);
  readonly #appActive = signal(true);
  readonly #lifecycleRevision = signal(0);
  #networkRevision = 0;
  readonly #listeners: PluginListenerHandle[] = [];
  #initialized = false;

  readonly state = computed<OfflineNetworkState>(() => {
    if (this.#osConnected() === false || this.#apiReachable() === false) return 'offline';
    if (this.#osConnected() === true && this.#apiReachable() === true) return 'online';
    return 'unverified';
  });
  readonly connected = computed(() => this.state() !== 'offline');
  /** Whether Capacitor currently permits foreground transport work. */
  readonly appActive = this.#appActive.asReadonly();
  /** Changes on every foreground/background transition, even when connectivity is unchanged. */
  readonly lifecycleRevision = this.#lifecycleRevision.asReadonly();

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    const [networkListener, appListener] = await Promise.all([
      this.addNetworkStatusListener(({ connected }) => {
        this.#networkRevision += 1;
        this.#osConnected.set(connected);
        this.#apiReachable.set(connected ? null : false);
      }),
      this.addAppStateListener(({ isActive }) => {
        this.#lifecycleRevision.update((revision) => revision + 1);
        this.#appActive.set(isActive);
        if (isActive) void this.#refreshOsStatus();
      }),
    ]);
    this.#listeners.push(networkListener, appListener);
    const networkRevision = this.#networkRevision;
    const lifecycleRevision = this.#lifecycleRevision();
    const [network, app] = await Promise.all([this.getNetworkStatus(), this.getAppState()]);
    if (this.#networkRevision === networkRevision) this.#osConnected.set(network.connected);
    if (this.#lifecycleRevision() === lifecycleRevision) this.#appActive.set(app.isActive);
  }

  markApiSuccess(): void {
    this.#apiReachable.set(true);
  }

  markApiFailure(): void {
    this.#apiReachable.set(false);
  }

  /** Factory seam for Capacitor app-state discovery and deterministic tests. */
  protected getAppState(): Promise<{ isActive: boolean }> {
    return App.getState();
  }

  /** Factory seam for Capacitor app-state listeners and deterministic tests. */
  protected addAppStateListener(listener: (state: { isActive: boolean }) => void): Promise<PluginListenerHandle> {
    return App.addListener('appStateChange', listener);
  }

  /** Factory seam for Capacitor network discovery and deterministic tests. */
  protected getNetworkStatus(): Promise<{ connected: boolean }> {
    return Network.getStatus();
  }

  /** Factory seam for Capacitor network listeners and deterministic tests. */
  protected addNetworkStatusListener(listener: (state: { connected: boolean }) => void): Promise<PluginListenerHandle> {
    return Network.addListener('networkStatusChange', listener);
  }

  async #refreshOsStatus(): Promise<void> {
    const revision = this.#networkRevision;
    const status = await this.getNetworkStatus();
    if (this.#networkRevision === revision) this.#osConnected.set(status.connected);
  }
}
