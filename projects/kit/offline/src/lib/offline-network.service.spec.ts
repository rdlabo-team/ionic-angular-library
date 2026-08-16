import type { PluginListenerHandle } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineNetworkService } from './offline-network.service';

class TestOfflineNetworkService extends OfflineNetworkService {
  appListener: ((state: { isActive: boolean }) => void) | null = null;
  networkListener: ((state: { connected: boolean }) => void) | null = null;
  readonly getAppStateMock = vi.fn<() => Promise<{ isActive: boolean }>>();
  readonly getNetworkStatusMock = vi.fn<() => Promise<{ connected: boolean }>>();

  protected override getAppState(): Promise<{ isActive: boolean }> {
    return this.getAppStateMock();
  }

  protected override getNetworkStatus(): Promise<{ connected: boolean }> {
    return this.getNetworkStatusMock();
  }

  protected override async addAppStateListener(
    listener: (state: { isActive: boolean }) => void,
  ): Promise<PluginListenerHandle> {
    this.appListener = listener;
    return { remove: vi.fn(async () => undefined) };
  }

  protected override async addNetworkStatusListener(
    listener: (state: { connected: boolean }) => void,
  ): Promise<PluginListenerHandle> {
    this.networkListener = listener;
    return { remove: vi.fn(async () => undefined) };
  }
}

describe('OfflineNetworkService', () => {
  let service: TestOfflineNetworkService;

  beforeEach(() => {
    service = new TestOfflineNetworkService();
    service.getAppStateMock.mockResolvedValue({ isActive: true });
    service.getNetworkStatusMock.mockResolvedValue({ connected: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it('initial app stateがinactiveならtransportをinactiveとして公開する', async () => {
    service.getAppStateMock.mockResolvedValue({ isActive: false });

    await service.initialize();

    expect(service.appActive()).toBe(false);
    expect(service.lifecycleRevision()).toBe(0);
  });

  it('listener登録後のappStateChangeを遅延した初期stateで上書きしない', async () => {
    let resolveInitialState!: (state: { isActive: boolean }) => void;
    service.getAppStateMock.mockImplementation(
      () => new Promise((resolve) => (resolveInitialState = resolve)),
    );
    const initialization = service.initialize();
    await vi.waitFor(() => {
      expect(service.appListener).not.toBeNull();
      expect(service.getAppStateMock).toHaveBeenCalledOnce();
    });

    service.appListener?.({ isActive: false });
    resolveInitialState({ isActive: true });
    await initialization;

    expect(service.appActive()).toBe(false);
    expect(service.lifecycleRevision()).toBe(1);
  });
});
