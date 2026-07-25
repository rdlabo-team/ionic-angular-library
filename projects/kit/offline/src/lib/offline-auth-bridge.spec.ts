import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { RouterStateSnapshot } from '@angular/router';
import type { KitAuthAccessLease, KitRemoteAccessRecovery } from '@rdlabo/ionic-angular-kit';
import { describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import { createOfflineAuthBridge, type OfflineAuthExchangeContext, type OfflineRemoteIdentity } from './offline-auth-bridge';
import type { OfflineCoordinatorService } from './offline-coordinator.service';

const stateStub = {} as RouterStateSnapshot;
const identity: OfflineRemoteIdentity = { userId: 1, scopeIds: [2], authSubject: 'subject-a' };

function assertRecovery(value: unknown): KitRemoteAccessRecovery {
  expect(value).toEqual(expect.objectContaining({ activate: expect.any(Function), resume: expect.any(Function) }));
  return value as KitRemoteAccessRecovery;
}

function createLease(initial = true): { lease: KitAuthAccessLease; invalidate: () => void } {
  let current = initial;
  return {
    lease: { isCurrent: () => current },
    invalidate: () => {
      current = false;
    },
  };
}

function setupBridge(
  overrides: Partial<Parameters<typeof createOfflineAuthBridge>[0]> & {
    exchangeImpl?: (context: OfflineAuthExchangeContext) => Promise<OfflineRemoteIdentity | null | false>;
  } = {},
) {
  const order: string[] = [];
  const exchangeContexts: OfflineAuthExchangeContext[] = [];
  const offline = {
    networkState: () => 'online',
    prepareRemoteSession: vi.fn(async () => {
      order.push('prepare');
      return true;
    }),
    resumeRemoteSession: vi.fn(async () => {
      order.push('resume');
    }),
    activateOfflineSession: vi.fn(async () => {
      order.push('activate-offline');
      return identity;
    }),
  } as unknown as OfflineCoordinatorService;

  const bridge = createOfflineAuthBridge({
    offline,
    exchange:
      overrides.exchangeImpl ??
      (async (context) => {
        order.push(`exchange-${context.phase}`);
        exchangeContexts.push(context);
        return identity;
      }),
    currentAuthSubject: overrides.currentAuthSubject ?? (() => 'subject-a'),
    isUnavailableError: overrides.isUnavailableError ?? (() => true),
    availability: overrides.availability ?? (() => of(true)),
    isIdentityCurrent: overrides.isIdentityCurrent,
    onRemoteResumed: overrides.onRemoteResumed,
    retryDelayMs: overrides.retryDelayMs,
  });

  return { bridge, offline, order, exchangeContexts };
}

describe('createOfflineAuthBridge', () => {
  it('orders exchange, prepareRemoteSession, grant, and resumeRemoteSession', async () => {
    const { bridge, offline, order } = setupBridge();
    const { lease } = createLease();

    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, lease));
    expect(order).toEqual(['exchange-authorize']);

    await recovery.activate(lease);
    expect(order).toEqual(['exchange-authorize', 'prepare']);
    expect(offline.prepareRemoteSession).toHaveBeenCalledWith(
      1,
      [2],
      'subject-a',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );

    await recovery.resume(lease);
    expect(order).toEqual(['exchange-authorize', 'prepare', 'resume']);
  });

  it('rejects activation when the lease becomes stale after exchange', async () => {
    const { lease, invalidate } = createLease();
    const { bridge } = setupBridge({
      exchangeImpl: async () => {
        invalidate();
        return identity;
      },
    });

    await expect(bridge.onAuthorized!(stateStub, lease)).resolves.toBe(false);
  });

  it('rejects activation when the identity is replaced before prepareRemoteSession', async () => {
    const isIdentityCurrent = vi.fn(() => true);
    const { bridge } = setupBridge({ isIdentityCurrent });
    const { lease } = createLease();

    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, lease));
    isIdentityCurrent.mockReturnValue(false);

    await expect(recovery.activate(lease)).resolves.toBe(false);
  });

  it('auth subjectが交換後に変わったidentityはprepareしない', async () => {
    let subject = 'subject-a';
    const { bridge, offline } = setupBridge({ currentAuthSubject: () => subject });
    const { lease } = createLease();

    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, lease));
    subject = 'subject-b';

    await expect(recovery.activate(lease)).resolves.toBe(false);
    expect(offline.prepareRemoteSession).not.toHaveBeenCalled();
  });

  it('prepareへ渡す複合leaseはidentity replacementをcommit直前にも検知する', async () => {
    const isIdentityCurrent = vi.fn(() => true);
    const { bridge, offline } = setupBridge({ isIdentityCurrent });
    const { lease } = createLease();
    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, lease));

    await recovery.activate(lease);
    const identityLease = vi.mocked(offline.prepareRemoteSession).mock.calls[0]?.[3];
    isIdentityCurrent.mockReturnValue(false);

    expect(identityLease?.isCurrent()).toBe(false);
  });

  it('activates offline fallback with the current auth subject', async () => {
    const { bridge, offline } = setupBridge({ currentAuthSubject: () => 'subject-a' });
    const { lease } = createLease();

    await expect(bridge.onUnavailable!(stateStub, { status: 0 }, lease)).resolves.toBe(true);
    expect(offline.activateOfflineSession).toHaveBeenCalledWith('subject-a', lease);
  });

  it('passes recover phase and lease through remote recovery exchange', async () => {
    const { bridge, exchangeContexts } = setupBridge();
    const { lease } = createLease();

    const recovery = await bridge.remoteRecovery!.reauthenticate(lease);
    assertRecovery(recovery);
    expect(exchangeContexts).toEqual([{ phase: 'recover', state: undefined, lease }]);
  });

  it('returns false from exchange when the product declines credential exchange', async () => {
    const { bridge } = setupBridge({ exchangeImpl: async () => false });
    const { lease } = createLease();

    await expect(bridge.onAuthorized!(stateStub, lease)).resolves.toBe(false);
    await expect(bridge.remoteRecovery!.reauthenticate(lease)).resolves.toBe(false);
  });

  it('exchange errorを握りつぶさずguard/recoveryへ伝播する', async () => {
    const unavailable = { status: 0 };
    const { bridge } = setupBridge({
      exchangeImpl: () => Promise.reject(unavailable),
    });
    const { lease } = createLease();

    await expect(bridge.onAuthorized!(stateStub, lease)).rejects.toBe(unavailable);
    await expect(bridge.remoteRecovery!.reauthenticate(lease)).rejects.toBe(unavailable);
  });

  it('propagates the configured unavailable error classifier', () => {
    const classifier = vi.fn((error: unknown) => (error as { status?: number }).status === 0);
    const { bridge } = setupBridge({ isUnavailableError: classifier });

    expect(bridge.isUnavailableError!({ status: 0 })).toBe(true);
    expect(bridge.isUnavailableError!({ status: 500 })).toBe(false);
    expect(classifier).toHaveBeenCalledTimes(2);
  });

  it('defaults availability to networkState !== offline', async () => {
    const offline = {
      networkState: signal('offline' as const),
      prepareRemoteSession: vi.fn(),
      resumeRemoteSession: vi.fn(),
      activateOfflineSession: vi.fn(),
    } as unknown as OfflineCoordinatorService;

    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const bridge = TestBed.runInInjectionContext(() =>
      createOfflineAuthBridge({
        offline,
        exchange: async () => identity,
        currentAuthSubject: () => null,
        isUnavailableError: () => true,
      }),
    );

    await expect(firstValueFrom(bridge.remoteRecovery!.availability())).resolves.toBe(false);
    TestBed.resetTestingModule();
  });

  it('uses a custom availability observable when supplied', () => {
    const availability = vi.fn(() => of(true));
    const { bridge } = setupBridge({ availability });

    bridge.remoteRecovery!.availability();
    expect(availability).toHaveBeenCalledOnce();
  });

  it('skips post-resume hooks when the lease becomes stale during transport resume', async () => {
    const onRemoteResumed = vi.fn(async () => undefined);
    const { bridge, offline } = setupBridge({ onRemoteResumed });
    const { lease, invalidate } = createLease();

    offline.resumeRemoteSession = vi.fn(async () => {
      invalidate();
    });

    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, lease));
    await recovery.activate(lease);
    await recovery.resume(lease);

    expect(offline.resumeRemoteSession).toHaveBeenCalledOnce();
    expect(onRemoteResumed).not.toHaveBeenCalled();
  });

  it('post-grant leaseがresume前に失効していればtransportを開始しない', async () => {
    const { bridge, offline } = setupBridge();
    const activationLease = createLease().lease;
    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, activationLease));
    await recovery.activate(activationLease);
    const { lease: resumeLease, invalidate } = createLease();
    invalidate();

    await recovery.resume(resumeLease);

    expect(offline.resumeRemoteSession).not.toHaveBeenCalled();
  });

  it('transport resume中にauth subjectが変わればproduct hookを実行しない', async () => {
    let subject = 'subject-a';
    const onRemoteResumed = vi.fn(async () => undefined);
    const { bridge, offline } = setupBridge({
      currentAuthSubject: () => subject,
      onRemoteResumed,
    });
    offline.resumeRemoteSession = vi.fn(async () => {
      subject = 'subject-b';
    });
    const { lease } = createLease();
    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, lease));
    await recovery.activate(lease);

    await recovery.resume(lease);

    expect(offline.resumeRemoteSession).toHaveBeenCalledOnce();
    expect(onRemoteResumed).not.toHaveBeenCalled();
  });

  it('resume後のproduct hookへidentityと元のauthorize contextを渡す', async () => {
    const onRemoteResumed = vi.fn(async () => undefined);
    const { bridge } = setupBridge({ onRemoteResumed });
    const { lease } = createLease();

    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, lease));
    await recovery.activate(lease);
    await recovery.resume(lease);

    expect(onRemoteResumed).toHaveBeenCalledWith({ phase: 'authorize', state: stateStub, lease, identity });
  });

  it('product固有identityを型付きのcurrent checkとresume hookへ保持する', async () => {
    const authSession = { uid: 'subject-a' };
    const productIdentity = { ...identity, authSession, redirectUrl: '/requested' };
    const navigate = vi.fn(async (_url: string) => undefined);
    const offline = {
      networkState: signal('online' as const),
      prepareRemoteSession: vi.fn(async () => true),
      resumeRemoteSession: vi.fn(async () => undefined),
      activateOfflineSession: vi.fn(async () => identity),
    } as unknown as OfflineCoordinatorService;
    const bridge = createOfflineAuthBridge({
      offline,
      availability: () => of(true),
      exchange: async () => productIdentity,
      currentAuthSubject: () => authSession.uid,
      isUnavailableError: () => false,
      isIdentityCurrent: (current) => current.authSession === authSession,
      onRemoteResumed: async ({ identity: current }) => navigate(current.redirectUrl),
    });
    const { lease } = createLease();

    const recovery = assertRecovery(await bridge.onAuthorized!(stateStub, lease));
    await recovery.activate(lease);
    await recovery.resume(lease);

    expect(navigate).toHaveBeenCalledWith('/requested');
  });

  it('不正なremote identityをsessionへ永続化する前に拒否する', async () => {
    const { bridge, offline } = setupBridge({
      exchangeImpl: async () => ({ ...identity, userId: 0 }),
    });
    const { lease } = createLease();

    await expect(bridge.onAuthorized!(stateStub, lease)).rejects.toThrow('Offline remote identity userId must be a positive safe integer.');
    expect(offline.prepareRemoteSession).not.toHaveBeenCalled();
  });
});
