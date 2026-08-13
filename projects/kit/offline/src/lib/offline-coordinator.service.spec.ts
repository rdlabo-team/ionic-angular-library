import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineCoordinatorService } from './offline-coordinator.service';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineNetworkService } from './offline-network.service';
import { OFFLINE_REPOSITORY, OFFLINE_SCHEMA_VERSION, type OfflineScope } from './offline-repository';
import { OfflineSessionService, type OfflineSessionManifest } from './offline-session.service';
import { OfflineStorageUnavailableError } from './offline-storage';
import { OfflineSyncService } from './offline-sync.service';
import { defineOfflineReplicaSchema } from './offline-replica-schema';

describe('OfflineCoordinatorService', () => {
  afterEach(() => TestBed.resetTestingModule());

  const emptyReplicaSchema = defineOfflineReplicaSchema({ version: 1, entities: [], migrations: [] });

  function setup(
    manifest: OfflineSessionManifest | null = null,
    options: {
      repositoryInitialize?: () => Promise<void>;
      onStorageUnavailable?: (error: OfflineStorageUnavailableError) => void | Promise<void>;
    } = {},
  ) {
    const order: string[] = [];
    const sessionState: { userId: number | null } = { userId: null };
    const repository = {
      initialize: vi.fn(options.repositoryInitialize ?? (async () => undefined)),
    };
    const network = {
      state: signal('connected'),
      initialize: vi.fn(async () => undefined),
    };
    const session = {
      initialize: vi.fn(async () => undefined),
      activateSession: vi.fn(
        async (userId: number, _scopeIds: readonly string[], _authSubject: string | null, lease: { isCurrent(): boolean }) => {
          order.push('activate-remote');
          if (!lease.isCurrent()) return false;
          sessionState.userId = userId;
          return true;
        },
      ),
      suspendRemoteSession: vi.fn(async () => void order.push('suspend-remote')),
      revokeAccess: vi.fn(() => void order.push('revoke')),
      activateOfflineSession: vi.fn(async () => {
        order.push('activate-local');
        return manifest;
      }),
      clearActiveSession: vi.fn(async () => {
        order.push('clear');
        sessionState.userId = null;
      }),
    };
    const sync = {
      syncState: signal('idle'),
      pendingCount: signal(0),
      conflicts: signal([]),
      initialize: vi.fn(async () => undefined),
      resetSession: vi.fn(async () => void order.push('reset')),
      revokeSession: vi.fn(() => void order.push('revoke-sync')),
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
        {
          provide: OFFLINE_KIT_OPTIONS,
          useValue: {
            databaseName: 'test-offline',
            replicaSchema: emptyReplicaSchema,
            onStorageUnavailable: options.onStorageUnavailable,
          },
        },
      ],
    });
    return {
      coordinator: TestBed.inject(OfflineCoordinatorService),
      order,
      session,
      sessionState,
      sync,
      network,
      repository,
    };
  }

  it('restores local visibility without starting remote synchronization', async () => {
    const manifest = { userId: 1, scopeIds: ['2'], authSubject: 'subject', updatedAt: 1 };
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

    await coordinator.prepareRemoteSession(1, ['2'], 'subject');
    expect(order).toEqual(['reset', 'suspend-remote', 'activate-remote']);

    await coordinator.resumeRemoteSession();
    expect(order).toEqual(['reset', 'suspend-remote', 'activate-remote', 'resume-remote']);
  });

  it('serializes logout after an in-flight activation so the old identity cannot reappear', async () => {
    const { coordinator, session, sessionState } = setup();
    let releaseActivation: (() => void) | undefined;
    let activationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      activationStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    session.activateSession.mockImplementationOnce(
      async (userId: number, _scopeIds: readonly string[], _subject: string | null, lease: { isCurrent(): boolean }) => {
        activationStarted?.();
        await gate;
        if (!lease.isCurrent()) return false;
        sessionState.userId = userId;
        return true;
      },
    );

    const activation = coordinator.prepareRemoteSession(1, ['2'], 'old-subject');
    await started;
    const logout = coordinator.clearActiveSession();
    releaseActivation?.();
    await Promise.all([activation, logout]);

    expect(sessionState.userId).toBeNull();
  });

  it('revokes runtime local access synchronously before queued durable cleanup', async () => {
    const { coordinator, session, sync } = setup();

    const clearing = coordinator.clearActiveSession();

    expect(session.revokeAccess).toHaveBeenCalledOnce();
    expect(sync.revokeSession).toHaveBeenCalledOnce();
    await clearing;
  });

  it('keeps a newer identity when an older activation completes late', async () => {
    const { coordinator, session, sessionState } = setup();
    let releaseOld: (() => void) | undefined;
    let oldStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    session.activateSession.mockImplementationOnce(
      async (userId: number, _scopeIds: readonly string[], _subject: string | null, lease: { isCurrent(): boolean }) => {
        oldStarted?.();
        await gate;
        if (!lease.isCurrent()) return false;
        sessionState.userId = userId;
        return true;
      },
    );

    const oldActivation = coordinator.prepareRemoteSession(1, ['2'], 'old-subject');
    await started;
    const newActivation = coordinator.prepareRemoteSession(9, ['10'], 'new-subject');
    releaseOld?.();

    await expect(oldActivation).resolves.toBe(false);
    await expect(newActivation).resolves.toBe(true);
    expect(sessionState.userId).toBe(9);
  });

  it('preserves user scope 0 from remote activation through the first pull', async () => {
    let lastUserId: number | null = null;
    let manifest: OfflineSessionManifest | null = null;
    const pull = vi.fn(async (_scope: OfflineScope) => undefined);
    const repository = {
      initialize: vi.fn(async () => undefined),
      getLastUserId: vi.fn(async () => lastUserId),
      setLastUserId: vi.fn(async (userId: number) => {
        lastUserId = userId;
      }),
      getSessionManifest: vi.fn(async () => manifest),
      putSessionManifest: vi.fn(async (_userId: number, value: OfflineSessionManifest) => {
        manifest = structuredClone(value);
      }),
      clearUser: vi.fn(async () => undefined),
      clearScope: vi.fn(async () => undefined),
    };
    const network = {
      state: signal('connected'),
      initialize: vi.fn(async () => undefined),
    };
    const sync = {
      syncState: signal('idle'),
      pendingCount: signal(0),
      conflicts: signal([]),
      initialize: vi.fn(async () => undefined),
      resetSession: vi.fn(async () => undefined),
      revokeSession: vi.fn(),
      refreshSession: vi.fn(async () => {
        const remote = await TestBed.inject(OfflineSessionService).getSession();
        await Promise.all((remote?.scopes ?? []).map((scope) => pull(scope)));
      }),
      refreshLocalSession: vi.fn(async () => undefined),
      discardAllPending: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        OfflineCoordinatorService,
        OfflineSessionService,
        { provide: OFFLINE_REPOSITORY, useValue: repository },
        { provide: OfflineNetworkService, useValue: network },
        { provide: OfflineSyncService, useValue: sync },
        {
          provide: OFFLINE_KIT_OPTIONS,
          useValue: {
            databaseName: 'test-offline',
            replicaSchema: emptyReplicaSchema,
          },
        },
      ],
    });
    const coordinator = TestBed.inject(OfflineCoordinatorService);

    await expect(coordinator.prepareRemoteSession(7, ['0'], 'subject')).resolves.toBe(true);
    await coordinator.resumeRemoteSession();

    expect(manifest).toMatchObject({ userId: 7, scopeIds: ['0'], authSubject: 'subject' });
    expect(pull).toHaveBeenCalledWith({ userId: 7, scopeId: '0' });
  });

  it('forwards foregroundScopeIds to refreshSession on resume', async () => {
    const { coordinator, sync } = setup();

    await coordinator.resumeRemoteSession({ foregroundScopeIds: ['2', '9'] });

    expect(sync.refreshSession).toHaveBeenCalledWith(['2', '9']);
  });

  describe('storage initialization failure', () => {
    const storageError = new OfflineStorageUnavailableError(
      'core_schema_incompatible',
      `Unsupported offline storage schema version 999; expected ${OFFLINE_SCHEMA_VERSION}.`,
    );

    it('default fails closed and does not start session or sync', async () => {
      const { coordinator, session, sync, network } = setup(null, {
        repositoryInitialize: async () => {
          throw storageError;
        },
      });

      await expect(coordinator.initialize()).rejects.toBe(storageError);

      expect(network.initialize).toHaveBeenCalledOnce();
      expect(session.initialize).not.toHaveBeenCalled();
      expect(sync.initialize).not.toHaveBeenCalled();
      expect(coordinator.storageState()).toEqual({ status: 'unavailable', error: storageError });
      expect(coordinator.isStorageReady()).toBe(false);
    });

    it('opt-in onStorageUnavailable completes initializer in unavailable state without session/sync', async () => {
      const onStorageUnavailable = vi.fn(async () => undefined);
      const { coordinator, session, sync, network } = setup(null, {
        repositoryInitialize: async () => {
          throw storageError;
        },
        onStorageUnavailable,
      });

      await expect(coordinator.initialize()).resolves.toBeUndefined();

      expect(onStorageUnavailable).toHaveBeenCalledExactlyOnceWith(storageError);
      expect(network.initialize).toHaveBeenCalledOnce();
      expect(session.initialize).not.toHaveBeenCalled();
      expect(sync.initialize).not.toHaveBeenCalled();
      expect(coordinator.storageState()).toEqual({ status: 'unavailable', error: storageError });
      expect(coordinator.isStorageReady()).toBe(false);
    });

    it('short-circuits repository-backed public APIs after online-only degradation', async () => {
      const { coordinator, session, sync } = setup(null, {
        repositoryInitialize: async () => {
          throw storageError;
        },
        onStorageUnavailable: async () => undefined,
      });
      await coordinator.initialize();

      await expect(coordinator.prepareRemoteSession(7, ['10'], 'subject')).resolves.toBe(true);
      await expect(coordinator.resumeRemoteSession({ foregroundScopeIds: ['10'] })).resolves.toBeUndefined();
      await expect(coordinator.activateOfflineSession('subject')).resolves.toBeNull();
      await expect(coordinator.flush()).resolves.toBeUndefined();
      await expect(coordinator.prepareLogout('sync')).resolves.toBe(true);
      await expect(coordinator.clearActiveSession()).resolves.toBeUndefined();

      expect(session.activateSession).not.toHaveBeenCalled();
      expect(session.activateOfflineSession).not.toHaveBeenCalled();
      expect(session.clearActiveSession).not.toHaveBeenCalled();
      expect(sync.resetSession).not.toHaveBeenCalled();
      expect(sync.refreshSession).not.toHaveBeenCalled();
      expect(sync.flush).not.toHaveBeenCalled();
    });

    it('callback failure still fails initialization', async () => {
      const callbackError = new Error('telemetry rejected');
      const onStorageUnavailable = vi.fn(async () => {
        throw callbackError;
      });
      const { coordinator, session, sync } = setup(null, {
        repositoryInitialize: async () => {
          throw storageError;
        },
        onStorageUnavailable,
      });

      await expect(coordinator.initialize()).rejects.toBe(callbackError);

      expect(onStorageUnavailable).toHaveBeenCalledExactlyOnceWith(storageError);
      expect(session.initialize).not.toHaveBeenCalled();
      expect(sync.initialize).not.toHaveBeenCalled();
      expect(coordinator.isStorageReady()).toBe(false);
    });

    it('wraps non-typed repository failures as storage_unavailable preserving cause', async () => {
      const cause = new Error('disk full');
      const onStorageUnavailable = vi.fn(async () => undefined);
      const { coordinator } = setup(null, {
        repositoryInitialize: async () => {
          throw cause;
        },
        onStorageUnavailable,
      });

      await coordinator.initialize();

      const state = coordinator.storageState();
      expect(state.status).toBe('unavailable');
      if (state.status !== 'unavailable') return;
      expect(state.error).toBeInstanceOf(OfflineStorageUnavailableError);
      expect(state.error.reason).toBe('storage_unavailable');
      expect(state.error.cause).toBe(cause);
      expect(onStorageUnavailable).toHaveBeenCalledExactlyOnceWith(state.error);
    });
  });
});
