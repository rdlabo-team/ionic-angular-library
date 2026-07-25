import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { OfflineCoordinatorService } from './offline-coordinator.service';
import { OfflineNetworkService } from './offline-network.service';
import { OFFLINE_REPOSITORY } from './offline-repository';
import { OfflineSessionService, type OfflineSessionManifest } from './offline-session.service';
import { OfflineSyncService } from './offline-sync.service';

describe('OfflineCoordinatorService', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(manifest: OfflineSessionManifest | null = null) {
    const order: string[] = [];
    const repository = {
      initialize: vi.fn(async () => undefined),
    };
    const network = {
      state: signal('connected'),
      initialize: vi.fn(async () => undefined),
    };
    const session = {
      initialize: vi.fn(async () => undefined),
      activateSession: vi.fn(async () => void order.push('activate-remote')),
      activateOfflineSession: vi.fn(async () => {
        order.push('activate-local');
        return manifest;
      }),
      clearActiveSession: vi.fn(async () => undefined),
    };
    const sync = {
      syncState: signal('idle'),
      pendingCount: signal(0),
      conflicts: signal([]),
      initialize: vi.fn(async () => undefined),
      resetSession: vi.fn(async () => void order.push('reset')),
      refreshSession: vi.fn(async () => void order.push('resume-remote')),
      refreshLocalSession: vi.fn(async () => void order.push('refresh-local')),
      discardAllPending: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        OfflineCoordinatorService,
        { provide: OFFLINE_REPOSITORY, useValue: repository },
        { provide: OfflineNetworkService, useValue: network },
        { provide: OfflineSessionService, useValue: session },
        { provide: OfflineSyncService, useValue: sync },
      ],
    });
    return { coordinator: TestBed.inject(OfflineCoordinatorService), order, session, sync };
  }

  it('restores local visibility without starting remote synchronization', async () => {
    const manifest = { userId: 1, scopeIds: [2], authSubject: 'subject', updatedAt: 1 };
    const { coordinator, order, sync } = setup(manifest);

    await expect(coordinator.activateOfflineSession('subject')).resolves.toEqual(manifest);

    expect(order).toEqual(['reset', 'activate-local', 'refresh-local']);
    expect(sync.refreshSession).not.toHaveBeenCalled();
  });

  it('does not expose local state when no verified manifest can be restored', async () => {
    const { coordinator, order, sync } = setup();

    await expect(coordinator.activateOfflineSession()).resolves.toBeNull();

    expect(order).toEqual(['reset', 'activate-local']);
    expect(sync.refreshLocalSession).not.toHaveBeenCalled();
  });

  it('separates remote identity activation from transport resume', async () => {
    const { coordinator, order } = setup();

    await coordinator.prepareRemoteSession(1, [2], 'subject');
    expect(order).toEqual(['reset', 'activate-remote']);

    await coordinator.resumeRemoteSession();
    expect(order).toEqual(['reset', 'activate-remote', 'resume-remote']);
  });
});
