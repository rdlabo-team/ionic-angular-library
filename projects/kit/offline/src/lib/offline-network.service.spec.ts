import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capacitor = vi.hoisted(() => ({
  appListener: null as ((state: { isActive: boolean }) => void) | null,
  networkListener: null as ((state: { connected: boolean }) => void) | null,
  getAppState: vi.fn<() => Promise<{ isActive: boolean }>>(),
  getNetworkStatus: vi.fn<() => Promise<{ connected: boolean }>>(),
}));

vi.mock('@capacitor/app', () => ({
  App: {
    getState: capacitor.getAppState,
    addListener: vi.fn(async (_event: string, listener: (state: { isActive: boolean }) => void) => {
      capacitor.appListener = listener;
      return { remove: vi.fn(async () => undefined) };
    }),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: capacitor.getNetworkStatus,
    addListener: vi.fn(async (_event: string, listener: (state: { connected: boolean }) => void) => {
      capacitor.networkListener = listener;
      return { remove: vi.fn(async () => undefined) };
    }),
  },
}));

import { OfflineNetworkService } from './offline-network.service';

describe('OfflineNetworkService', () => {
  beforeEach(() => {
    capacitor.appListener = null;
    capacitor.networkListener = null;
    capacitor.getAppState.mockReset().mockResolvedValue({ isActive: true });
    capacitor.getNetworkStatus.mockReset().mockResolvedValue({ connected: true });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('initial app stateがinactiveならtransportをinactiveとして公開する', async () => {
    capacitor.getAppState.mockResolvedValue({ isActive: false });
    const service = TestBed.inject(OfflineNetworkService);

    await service.initialize();

    expect(service.appActive()).toBe(false);
    expect(service.lifecycleRevision()).toBe(0);
  });

  it('listener登録後のappStateChangeを遅延した初期stateで上書きしない', async () => {
    let resolveInitialState!: (state: { isActive: boolean }) => void;
    capacitor.getAppState.mockImplementation(
      () => new Promise((resolve) => (resolveInitialState = resolve)),
    );
    const service = TestBed.inject(OfflineNetworkService);
    const initialization = service.initialize();
    await vi.waitFor(() => {
      expect(capacitor.appListener).not.toBeNull();
      expect(capacitor.getAppState).toHaveBeenCalledOnce();
    });

    capacitor.appListener?.({ isActive: false });
    resolveInitialState({ isActive: true });
    await initialization;

    expect(service.appActive()).toBe(false);
    expect(service.lifecycleRevision()).toBe(1);
  });
});
