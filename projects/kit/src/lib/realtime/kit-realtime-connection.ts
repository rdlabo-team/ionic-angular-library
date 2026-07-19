import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { Subject } from 'rxjs';

/** One WebSocket endpoint and its ordered subprotocol list. */
export interface KitRealtimeSocketTarget {
  url: string;
  protocols: string[];
}

/** Realtime event shape required for self-echo identification. */
export interface KitRealtimeEvent {
  originId?: string;
}

/** An application event annotated with whether it originated from this client. */
export type KitClientRealtimeEvent<TEvent extends KitRealtimeEvent> = TEvent & { isSelf: boolean };

/** Timing and protocol options for {@link KitRealtimeConnection}. */
export interface KitRealtimeConnectionOptions {
  clientId?: string;
  ping?: string;
  pong?: string;
  maxBackoffMs?: number;
  openTimeoutMs?: number;
  pingIntervalMs?: number;
  livenessTimeoutMs?: number;
}

interface SocketHealth {
  lastActivityAt: number;
  openTimer: ReturnType<typeof setTimeout> | null;
  watchdog: KitRealtimeLivenessWatchdog;
}

/** Stable per-tab/application-run ID shared by realtime connections and write headers. */
export const KIT_REALTIME_CLIENT_ID = crypto.randomUUID();

/** Convert an HTTP(S) endpoint to its WebSocket equivalent. */
export function toKitWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  } else if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  }
  return parsed.toString();
}

/** Build the standard application/auth/client WebSocket subprotocol list. */
export function kitRealtimeProtocols(
  protocol: string,
  options: { clientId?: string; authToken?: string; authPrefix?: string; clientPrefix?: string } = {},
): string[] {
  const protocols = [protocol];
  if (options.authToken) {
    protocols.push(`${options.authPrefix ?? 'auth.'}${options.authToken}`);
  }
  protocols.push(`${options.clientPrefix ?? 'client.'}${options.clientId ?? KIT_REALTIME_CLIENT_ID}`);
  return protocols;
}

/** Detect a half-open WebSocket when no pong or event arrives before the timeout. */
export class KitRealtimeLivenessWatchdog {
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  /** Restart the liveness deadline after receiving server activity. */
  reset(): void {
    this.clear();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.onTimeout();
    }, this.timeoutMs);
  }

  /** Cancel the current liveness deadline. */
  clear(): void {
    if (!this.#timer) {
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/**
 * Reconnecting Hibernation WebSocket client for Ionic/Capacitor applications.
 *
 * Subclasses provide connection intent and one or more targets. The base owns foreground/network
 * suspension, exponential backoff, open/liveness timeouts, runtime-friendly application pings,
 * all-target atomic reconnect, and a resync signal after connectivity is restored.
 */
@Injectable()
export abstract class KitRealtimeConnection<TEvent extends KitRealtimeEvent> {
  readonly #events$ = new Subject<KitClientRealtimeEvent<TEvent>>();
  readonly #reconnected$ = new Subject<void>();

  /** Client ID used to classify self echoes. */
  protected readonly listeners: PluginListenerHandle[] = [];

  #sockets = new Set<WebSocket>();
  readonly #health = new Map<WebSocket, SocketHealth>();
  #opening = false;
  #generation = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectAttempt = 0;
  #isAppActive = true;
  #isNetworkConnected = true;
  #lifecycleRegistration: Promise<void> | null = null;
  #lifecycleGeneration = 0;

  /** All parsed events received by this connection. */
  readonly events$: Observable<KitClientRealtimeEvent<TEvent>> = this.#events$.asObservable();
  /** Emits after every fully established connection cycle, including the first, prompting a REST resync. */
  readonly reconnected$: Observable<void> = this.#reconnected$.asObservable();

  /** Override timing/protocol defaults in specialized clients or tests. */
  protected get realtimeOptions(): KitRealtimeConnectionOptions {
    return {};
  }

  get #options(): Required<KitRealtimeConnectionOptions> {
    const options = this.realtimeOptions;
    return {
      clientId: options.clientId ?? KIT_REALTIME_CLIENT_ID,
      ping: options.ping ?? 'ping',
      pong: options.pong ?? 'pong',
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      openTimeoutMs: options.openTimeoutMs ?? 15_000,
      pingIntervalMs: options.pingIntervalMs ?? 30_000,
      livenessTimeoutMs: options.livenessTimeoutMs ?? 70_000,
    };
  }

  /** Client ID used to classify self echoes. */
  get id(): string {
    return this.#options.clientId;
  }

  /** Whether every configured socket is currently open. */
  get isStreamOpen(): boolean {
    return this.#sockets.size > 0 && [...this.#sockets].every((socket) => socket.readyState === WebSocket.OPEN);
  }

  /** Whether every configured socket has produced recent server activity. */
  get isStreamHealthy(): boolean {
    return (
      this.isStreamOpen &&
      [...this.#health.values()].every(({ lastActivityAt }) => Date.now() - lastActivityAt < this.#options.livenessTimeoutMs)
    );
  }

  protected abstract get shouldConnect(): boolean;
  protected abstract buildSocketTargets(): Promise<KitRealtimeSocketTarget[]>;

  get #canOpen(): boolean {
    return this.shouldConnect && this.#isAppActive && this.#isNetworkConnected;
  }

  /** Hook used by authenticated clients to invalidate a token after handshake failure. */
  protected handleConnectionFailure(): Promise<void> {
    return Promise.resolve();
  }

  /** Parse a text WebSocket message into one or more domain events. */
  protected parseMessage(data: string): TEvent[] {
    const parsed = JSON.parse(data) as TEvent | TEvent[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  /** Factory seam for platform-specific WebSocket implementations and unit tests. */
  protected createWebSocket(url: string, protocols: string[]): WebSocket {
    return new WebSocket(url, protocols);
  }

  /** Factory seam for Capacitor app-state listeners. */
  protected addAppStateListener(listener: (state: { isActive: boolean }) => void): Promise<PluginListenerHandle> {
    return App.addListener('appStateChange', listener);
  }

  /** Factory seam for Capacitor network-status listeners. */
  protected addNetworkStatusListener(listener: (status: { connected: boolean }) => void): Promise<PluginListenerHandle> {
    return Network.addListener('networkStatusChange', listener);
  }

  /** Register foreground/network listeners exactly once, cleaning up handles that resolve after disconnect. */
  protected async registerLifecycleListeners(): Promise<void> {
    if (this.listeners.length > 0) {
      return;
    }
    if (this.#lifecycleRegistration) {
      return this.#lifecycleRegistration;
    }
    const generation = this.#lifecycleGeneration;
    this.#lifecycleRegistration = (async () => {
      const appHandle = await this.addAppStateListener(({ isActive }) => {
        this.#isAppActive = isActive;
        if (this.#canOpen) {
          void this.open();
        } else {
          this.suspend();
        }
      });
      if (generation !== this.#lifecycleGeneration) {
        await appHandle.remove();
        return;
      }
      this.listeners.push(appHandle);

      const networkHandle = await this.addNetworkStatusListener(({ connected }) => {
        this.#isNetworkConnected = connected;
        if (this.#canOpen) {
          void this.open();
        } else {
          this.suspend();
        }
      });
      if (generation !== this.#lifecycleGeneration) {
        await networkHandle.remove();
        return;
      }
      this.listeners.push(networkHandle);
    })();
    try {
      await this.#lifecycleRegistration;
    } finally {
      this.#lifecycleRegistration = null;
    }
  }

  /** Remove all lifecycle listeners, including listeners whose async registration has not completed yet. */
  protected removeLifecycleListeners(): void {
    this.#lifecycleGeneration += 1;
    this.listeners.forEach((handle) => void handle.remove());
    this.listeners.length = 0;
  }

  /** Suspend sockets without changing the subclass connection intent. */
  protected suspend(): void {
    this.#clearReconnectTimer();
    this.#closeSockets();
  }

  /** Reset resync and backoff history when the owning session ends. */
  protected resetConnectionState(): void {
    this.#reconnectAttempt = 0;
  }

  /** Open every current target, or schedule an atomic reconnect if any target fails. */
  protected async open(): Promise<void> {
    if (!this.#canOpen || this.#opening || this.#sockets.size > 0) {
      return;
    }
    this.#clearReconnectTimer();
    this.#opening = true;
    const generation = ++this.#generation;

    try {
      const targets = await this.buildSocketTargets();
      if (!this.#canOpen || generation !== this.#generation) {
        return;
      }
      if (targets.length === 0) {
        this.#opening = false;
        return;
      }

      const openedSockets = new Set<WebSocket>();
      for (const target of targets) {
        const socket = this.createWebSocket(toKitWebSocketUrl(target.url), target.protocols);
        const health: SocketHealth = {
          lastActivityAt: 0,
          openTimer: null,
          watchdog: new KitRealtimeLivenessWatchdog(this.#options.livenessTimeoutMs, () => this.#connectionFailed(generation)),
        };
        this.#sockets.add(socket);
        this.#health.set(socket, health);
        health.openTimer = setTimeout(() => this.#connectionFailed(generation), this.#options.openTimeoutMs);

        socket.onopen = () => {
          if (generation !== this.#generation) {
            return;
          }
          this.#clearOpenTimer(health);
          this.#markActivity(health);
          this.#startPing();
          openedSockets.add(socket);
          if (openedSockets.size !== targets.length) {
            return;
          }
          this.#opening = false;
          this.#reconnected$.next();
        };
        socket.onmessage = ({ data }) => {
          if (generation !== this.#generation || typeof data !== 'string') {
            return;
          }
          this.#reconnectAttempt = 0;
          this.#markActivity(health);
          if (data === this.#options.pong) {
            return;
          }
          try {
            for (const event of this.parseMessage(data)) {
              this.#events$.next({ ...event, isSelf: event.originId === this.id });
            }
          } catch {
            // Ignore malformed application messages while retaining the healthy socket.
          }
        };
        socket.onerror = () => this.#connectionFailed(generation);
        socket.onclose = () => this.#connectionFailed(generation);
      }
    } catch {
      this.#connectionFailed(generation);
    } finally {
      if (generation === this.#generation && this.#sockets.size === 0) {
        this.#opening = false;
      }
    }
  }

  #connectionFailed(generation: number): void {
    if (generation !== this.#generation) {
      return;
    }
    this.#closeSockets();
    void this.handleConnectionFailure()
      .catch(() => undefined)
      .finally(() => this.#scheduleReconnect());
  }

  #markActivity(health: SocketHealth): void {
    health.lastActivityAt = Date.now();
    health.watchdog.reset();
  }

  #startPing(): void {
    if (this.#pingTimer) {
      return;
    }
    this.#pingTimer = setInterval(() => {
      for (const socket of this.#sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(this.#options.ping);
        }
      }
    }, this.#options.pingIntervalMs);
  }

  #closeSockets(): void {
    this.#generation += 1;
    this.#opening = false;
    this.#clearPingTimer();
    const sockets = this.#sockets;
    this.#sockets = new Set();
    for (const socket of sockets) {
      const health = this.#health.get(socket);
      if (health) {
        health.watchdog.clear();
        this.#clearOpenTimer(health);
      }
      this.#health.delete(socket);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000, 'client suspended');
      } catch {
        // Reconnect processing continues even if a CONNECTING socket cannot close cleanly.
      }
    }
  }

  #scheduleReconnect(): void {
    if (!this.#canOpen || this.#reconnectTimer || this.#sockets.size > 0) {
      return;
    }
    const delay = Math.min(1000 * 2 ** this.#reconnectAttempt, this.#options.maxBackoffMs);
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.open();
    }, delay);
  }

  #clearOpenTimer(health: SocketHealth): void {
    if (!health.openTimer) {
      return;
    }
    clearTimeout(health.openTimer);
    health.openTimer = null;
  }

  #clearPingTimer(): void {
    if (!this.#pingTimer) {
      return;
    }
    clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  #clearReconnectTimer(): void {
    if (!this.#reconnectTimer) {
      return;
    }
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }
}
