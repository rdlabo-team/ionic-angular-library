import type { PluginListenerHandle } from '@capacitor/core';
import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
  pendingFailureHook: Promise<void> | null = null;
  failureCalls = 0;
  readonly sockets: FakeWebSocket[] = [];
  readonly removeAppListener = vi.fn(() => Promise.resolve());
  readonly removeNetworkListener = vi.fn(() => Promise.resolve());
  appListenerResolver: ((handle: PluginListenerHandle) => void) | null = null;

  protected override get realtimeOptions(): { clientId: string } {
    return { clientId: 'self' };
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
    if (this.pendingFailureHook) {
      return this.pendingFailureHook;
    }
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

@Injectable()
class InheritedConstructorConnection extends KitRealtimeConnection<TestEvent> {
  protected readonly shouldConnect = false;

  protected buildSocketTargets(): Promise<{ url: string; protocols: string[] }[]> {
    return Promise.resolve([]);
  }
}

describe('KitRealtimeConnection', () => {
  afterEach(() => vi.useRealTimers());

  it('converts endpoints and builds auth/client subprotocols', () => {
    expect(toKitWebSocketUrl('https://example.test/realtime')).toBe('wss://example.test/realtime');
    expect(toKitWebSocketUrl('wss://example.test/realtime')).toBe('wss://example.test/realtime');
    expect(kitRealtimeProtocols('app-v1', { authToken: 'token', clientId: 'client' })).toEqual(['app-v1', 'auth.token', 'client.client']);
  });

  it('can be inherited by an Angular injectable without declaring a constructor', () => {
    TestBed.configureTestingModule({ providers: [InheritedConstructorConnection] });
    expect(TestBed.inject(InheritedConstructorConnection)).toBeInstanceOf(InheritedConstructorConnection);
  });

  it('pings all targets and reconnects only the target that closes', async () => {
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
    expect(connection.sockets).toHaveLength(3);
    expect(connection.sockets[1].readyState).toBe(WebSocket.OPEN);
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

  it('requests a REST resync when the initial socket connection is fully established', async () => {
    const connection = new TestConnection();
    const reconnected = vi.fn();
    connection.reconnected$.subscribe(reconnected);
    await connection.openForTest();

    connection.sockets[0].open();

    expect(reconnected).toHaveBeenCalledOnce();
    connection.stop();
  });

  it('emits resync after a partial multi-target connection failure recovers', async () => {
    vi.useFakeTimers();
    const connection = new TestConnection();
    connection.targetCount = 2;
    const reconnected = vi.fn();
    const events: TestEvent[] = [];
    connection.reconnected$.subscribe(reconnected);
    connection.events$.subscribe((event) => events.push(event));
    await connection.openForTest();
    connection.sockets[0].open();
    connection.sockets[1].close();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1000);
    connection.sockets[2].open();
    connection.sockets[0].message(JSON.stringify({ topic: 'healthy-target' }));
    expect(reconnected).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ topic: 'healthy-target' }));
    connection.stop();
  });

  it('does not amplify repeated single-target failures into all-target reconnect waves', async () => {
    vi.useFakeTimers();
    const connection = new TestConnection();
    connection.targetCount = 20;
    await connection.openForTest();
    connection.sockets.forEach((socket) => socket.open());
    let failedSocket = connection.sockets[0];

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (attempt % 20 === 0) {
        connection.sockets.filter((socket) => socket.readyState === WebSocket.OPEN).forEach((socket) => socket.message('pong'));
      }
      failedSocket.close();
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(1000);
      failedSocket = connection.sockets.at(-1)!;
      failedSocket.open();
    }

    expect(connection.sockets).toHaveLength(120);
    expect(connection.sockets.slice(1, 20).every((socket) => socket.readyState === WebSocket.OPEN)).toBe(true);
    connection.stop();
  });

  it('closes every remaining socket when a retry resolves to an empty target set', async () => {
    vi.useFakeTimers();
    const connection = new TestConnection();
    connection.targetCount = 2;
    await connection.openForTest();
    connection.sockets.forEach((socket) => socket.open());
    connection.targetCount = 0;

    connection.sockets[0].close();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1000);

    expect(connection.sockets[1].readyState).toBe(WebSocket.CLOSED);
    expect(connection.isStreamOpen).toBe(false);
    connection.stop();
  });

  it('coalesces concurrent target failures into one retry while retaining healthy targets', async () => {
    vi.useFakeTimers();
    const connection = new TestConnection();
    connection.targetCount = 3;
    await connection.openForTest();
    connection.sockets.forEach((socket) => socket.open());

    connection.sockets[0].close();
    connection.sockets[1].close();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1000);

    expect(connection.failureCalls).toBe(1);
    expect(connection.sockets).toHaveLength(5);
    expect(connection.sockets[2].readyState).toBe(WebSocket.OPEN);
    connection.stop();
  });

  it('ignores a failure hook that resolves after a new connection generation starts', async () => {
    vi.useFakeTimers();
    let resolveOldFailure!: () => void;
    const connection = new TestConnection();
    connection.pendingFailureHook = new Promise<void>((resolve) => {
      resolveOldFailure = resolve;
    });
    await connection.openForTest();
    connection.sockets[0].open();

    connection.sockets[0].close();
    await vi.runAllTicks();
    connection.stop();
    connection.connectEnabled = true;
    connection.pendingFailureHook = null;
    await connection.openForTest();
    connection.sockets[1].open();

    resolveOldFailure();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connection.sockets).toHaveLength(2);
    expect(connection.sockets[1].readyState).toBe(WebSocket.OPEN);
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
