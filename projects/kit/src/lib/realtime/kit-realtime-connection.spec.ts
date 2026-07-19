import type { PluginListenerHandle } from '@capacitor/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kitRealtimeProtocols, KitRealtimeConnection, KitRealtimeLivenessWatchdog, toKitWebSocketUrl } from './kit-realtime-connection';

interface TestEvent {
  topic: string;
  originId?: string;
}

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly send = vi.fn();

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  message(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

class TestConnection extends KitRealtimeConnection<TestEvent> {
  connectEnabled = true;
  targetCount = 1;
  failTargets = false;
  failFailureHook = false;
  failureCalls = 0;
  readonly sockets: FakeWebSocket[] = [];
  readonly removeAppListener = vi.fn(() => Promise.resolve());
  readonly removeNetworkListener = vi.fn(() => Promise.resolve());
  appListenerResolver: ((handle: PluginListenerHandle) => void) | null = null;

  constructor() {
    super({ clientId: 'self', openTimeoutMs: 15_000, pingIntervalMs: 30_000, livenessTimeoutMs: 70_000 });
  }

  protected get shouldConnect(): boolean {
    return this.connectEnabled;
  }

  protected buildSocketTargets(): Promise<{ url: string; protocols: string[] }[]> {
    if (this.failTargets) {
      return Promise.reject(new Error('token failed'));
    }
    return Promise.resolve(
      Array.from({ length: this.targetCount }, (_, index) => ({
        url: `https://example.test/realtime/${index}`,
        protocols: ['test'],
      })),
    );
  }

  protected override handleConnectionFailure(): Promise<void> {
    this.failureCalls += 1;
    if (this.failFailureHook) {
      return Promise.reject(new Error('storage unavailable'));
    }
    return Promise.resolve();
  }

  protected override createWebSocket(): WebSocket {
    const socket = new FakeWebSocket();
    this.sockets.push(socket);
    return socket as unknown as WebSocket;
  }

  protected override addAppStateListener(): Promise<PluginListenerHandle> {
    return new Promise((resolve) => {
      this.appListenerResolver = resolve;
    });
  }

  protected override addNetworkStatusListener(): Promise<PluginListenerHandle> {
    return Promise.resolve({ remove: this.removeNetworkListener });
  }

  openForTest(): Promise<void> {
    return this.open();
  }

  stop(): void {
    this.connectEnabled = false;
    this.suspend();
  }

  registerLifecycleForTest(): Promise<void> {
    return this.registerLifecycleListeners();
  }

  removeLifecycleForTest(): void {
    this.removeLifecycleListeners();
  }
}

describe('KitRealtimeConnection', () => {
  afterEach(() => vi.useRealTimers());

  it('converts endpoints and builds auth/client subprotocols', () => {
    expect(toKitWebSocketUrl('https://example.test/realtime')).toBe('wss://example.test/realtime');
    expect(toKitWebSocketUrl('wss://example.test/realtime')).toBe('wss://example.test/realtime');
    expect(kitRealtimeProtocols('app-v1', { authToken: 'token', clientId: 'client' })).toEqual(['app-v1', 'auth.token', 'client.client']);
  });

  it('pings all targets and atomically reconnects after one closes', async () => {
    vi.useFakeTimers();
    const connection = new TestConnection();
    connection.targetCount = 2;
    await connection.openForTest();
    connection.sockets.forEach((socket) => socket.open());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connection.sockets[0].send).toHaveBeenCalledWith('ping');
    expect(connection.sockets[1].send).toHaveBeenCalledWith('ping');

    connection.sockets[0].close();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.sockets).toHaveLength(4);
    connection.stop();
  });

  it('marks self echoes and expands event batches', async () => {
    const connection = new TestConnection();
    const events: (TestEvent & { isSelf: boolean })[] = [];
    connection.events$.subscribe((event) => events.push(event));
    await connection.openForTest();
    connection.sockets[0].open();
    connection.sockets[0].message(
      JSON.stringify([
        { topic: 'one', originId: 'self' },
        { topic: 'two', originId: 'other' },
      ]),
    );
    expect(events).toEqual([
      { topic: 'one', originId: 'self', isSelf: true },
      { topic: 'two', originId: 'other', isSelf: false },
    ]);
    connection.stop();
  });

  it('emits resync after a partial multi-target connection failure recovers', async () => {
    vi.useFakeTimers();
    const connection = new TestConnection();
    connection.targetCount = 2;
    const reconnected = vi.fn();
    connection.reconnected$.subscribe(reconnected);
    await connection.openForTest();
    connection.sockets[0].open();
    connection.sockets[1].close();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1000);
    connection.sockets[2].open();
    connection.sockets[3].open();
    expect(reconnected).toHaveBeenCalledOnce();
    connection.stop();
  });

  it('retries target construction failure with backoff', async () => {
    vi.useFakeTimers();
    const connection = new TestConnection();
    connection.failTargets = true;
    await connection.openForTest();
    expect(connection.failureCalls).toBe(1);
    connection.failTargets = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.sockets).toHaveLength(1);
    connection.stop();
  });

  it('reconnects even when the connection-failure hook rejects', async () => {
    vi.useFakeTimers();
    const connection = new TestConnection();
    connection.failFailureHook = true;
    await connection.openForTest();
    connection.sockets[0].close();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.sockets).toHaveLength(2);
    connection.stop();
  });

  it('removes an app listener that resolves after lifecycle teardown', async () => {
    const connection = new TestConnection();
    const registering = connection.registerLifecycleForTest();
    connection.removeLifecycleForTest();
    connection.appListenerResolver?.({ remove: connection.removeAppListener });
    await registering;
    expect(connection.removeAppListener).toHaveBeenCalledOnce();
    expect(connection.removeNetworkListener).not.toHaveBeenCalled();
  });
});

describe('KitRealtimeLivenessWatchdog', () => {
  afterEach(() => vi.useRealTimers());

  it('times out and can be cleared', () => {
    vi.useFakeTimers();
    const timeout = vi.fn();
    const watchdog = new KitRealtimeLivenessWatchdog(1000, timeout);
    watchdog.reset();
    vi.advanceTimersByTime(999);
    expect(timeout).not.toHaveBeenCalled();
    watchdog.clear();
    vi.advanceTimersByTime(1);
    expect(timeout).not.toHaveBeenCalled();
    watchdog.reset();
    vi.advanceTimersByTime(1000);
    expect(timeout).toHaveBeenCalledOnce();
  });
});
