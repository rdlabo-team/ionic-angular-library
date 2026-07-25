import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  KIT_AUTH_RECOVERY_CONFIG,
  KitAuthAccessService,
  KitAuthRecoveryService,
  type KitAuthRecoveryConfig,
  type KitRemoteAccessRecovery,
} from './auth-access.service';

describe('KitAuthRecoveryService', () => {
  function setup(config: KitAuthRecoveryConfig) {
    const errorHandler = { handleError: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        KitAuthAccessService,
        KitAuthRecoveryService,
        { provide: KIT_AUTH_RECOVERY_CONFIG, useValue: config },
        { provide: ErrorHandler, useValue: errorHandler },
      ],
    });
    return {
      access: TestBed.inject(KitAuthAccessService),
      recovery: TestBed.inject(KitAuthRecoveryService),
      errorHandler,
    };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('recovers in reauthenticate → activate → remote publish → resume order', async () => {
    const availability = new Subject<boolean>();
    const order: string[] = [];
    const reauthenticate = vi.fn(async () => {
      order.push('reauthenticate');
      return {
        activate: async () => {
          order.push('activate');
          return true;
        },
        resume: async () => {
          order.push(`resume:${TestBed.inject(KitAuthAccessService).mode}`);
        },
      };
    });
    const setupResult = setup({
      remoteRecovery: { availability: () => availability, reauthenticate },
      isUnavailableError: (error) => (error as { status?: number })?.status === 0,
    });
    const access = setupResult.access;
    access.grantLocal();
    setupResult.recovery.initialize();

    availability.next(true);
    await setupResult.recovery.recover();

    expect(order).toEqual(['reauthenticate', 'activate', 'resume:remote']);
    expect(access.mode).toBe('remote');
    expect(reauthenticate).toHaveBeenCalledOnce();
  });

  it('invalidates the post-grant resume lease when access is revoked during recovery', async () => {
    let markResumeStarted!: () => void;
    let releaseResume!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      markResumeStarted = resolve;
    });
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const userVisibleEffect = vi.fn();
    const { access, recovery } = setup({
      remoteRecovery: {
        availability: () => new Subject<boolean>(),
        reauthenticate: async () => ({
          activate: async () => true,
          resume: async (lease) => {
            markResumeStarted();
            await resumeGate;
            if (lease?.isCurrent()) userVisibleEffect();
          },
        }),
      },
    });
    access.grantLocal();

    const pending = recovery.recover();
    await resumeStarted;
    access.clear();
    releaseResume();
    await pending;

    expect(userVisibleEffect).not.toHaveBeenCalled();
    expect(access.mode).toBe('none');
  });

  it('does not reclaim a transition started by a synchronous remote-mode subscriber', async () => {
    const userVisibleEffect = vi.fn();
    const { access, recovery } = setup({
      remoteRecovery: {
        availability: () => new Subject<boolean>(),
        reauthenticate: async () => ({
          activate: async () => true,
          resume: async (lease) => {
            if (lease?.isCurrent()) userVisibleEffect();
          },
        }),
      },
    });
    access.grantLocal();
    const subscription = access.mode$.subscribe((mode) => {
      if (mode === 'remote') access.clear();
    });

    await recovery.recover();
    subscription.unsubscribe();

    expect(userVisibleEffect).not.toHaveBeenCalled();
    expect(access.mode).toBe('none');
  });

  it('coalesces concurrent recovery attempts into one flight', async () => {
    let resolveRecovery: ((value: false) => void) | undefined;
    const reauthenticate = vi.fn(
      () =>
        new Promise<false>((resolve) => {
          resolveRecovery = resolve;
        }),
    );
    const { access, recovery } = setup({
      remoteRecovery: { availability: () => new Subject<boolean>(), reauthenticate },
    });
    access.grantLocal();

    const first = recovery.recover();
    const second = recovery.recover();
    resolveRecovery?.(false);
    await Promise.all([first, second]);

    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(access.mode).toBe('none');
  });

  it('keeps local mode on transport failure and clears it on explicit denial', async () => {
    const transportError = { status: 0 };
    const denied = { status: 401 };
    const reauthenticate = vi.fn().mockRejectedValueOnce(transportError).mockRejectedValueOnce(denied);
    const { access, recovery } = setup({
      remoteRecovery: { availability: () => new Subject<boolean>(), reauthenticate },
      isUnavailableError: (error) => error === transportError,
    });
    access.grantLocal();

    await recovery.recover();
    expect(access.mode).toBe('local');
    await recovery.recover();
    expect(access.mode).toBe('none');
  });

  it('retries authentication while local access remains active even without a new availability event', async () => {
    vi.useFakeTimers();
    const availability = new Subject<boolean>();
    const transportError = { status: 0 };
    const reauthenticate = vi
      .fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce({
        activate: async () => true,
        resume: async () => undefined,
      });
    const { access, recovery } = setup({
      remoteRecovery: { availability: () => availability, retryDelayMs: 1000, reauthenticate },
      isUnavailableError: (error) => error === transportError,
    });
    recovery.initialize();
    access.grantLocal();

    await vi.advanceTimersByTimeAsync(1000);
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(access.mode).toBe('local');

    await vi.advanceTimersByTimeAsync(1000);
    expect(reauthenticate).toHaveBeenCalledTimes(2);
    expect(access.mode).toBe('remote');
    vi.useRealTimers();
  });

  it('does not bypass retryDelay for coalesced recovery calls in the same access revision', async () => {
    vi.useFakeTimers();
    const availability = new Subject<boolean>();
    let rejectOld: ((error: unknown) => void) | undefined;
    const reauthenticate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockRejectedValue({ status: 0 });
    const { access, recovery } = setup({
      remoteRecovery: { availability: () => availability, retryDelayMs: 1_000, reauthenticate },
      isUnavailableError: (error) => (error as { status?: number })?.status === 0,
    });
    recovery.initialize();
    access.grantLocal();
    availability.next(true);
    const first = recovery.recover();
    availability.next(true);
    recovery.recover();
    rejectOld?.({ status: 0 });
    await first;

    expect(reauthenticate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(reauthenticate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(reauthenticate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('reruns recovery for a newer local transition after the stale single flight settles', async () => {
    const availability = new Subject<boolean>();
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const reauthenticate = vi
      .fn()
      .mockImplementationOnce(async () => {
        await oldGate;
        return {
          activate: async () => true,
          resume: async () => undefined,
        };
      })
      .mockResolvedValueOnce({
        activate: async () => true,
        resume: async () => undefined,
      });
    const { access, recovery } = setup({
      remoteRecovery: { availability: () => availability, reauthenticate },
    });
    recovery.initialize();
    access.grantLocal();
    availability.next(true);
    await Promise.resolve();

    access.grantLocal();
    releaseOld?.();
    await vi.waitFor(() => expect(reauthenticate).toHaveBeenCalledTimes(2));
    await recovery.recover();

    expect(access.mode).toBe('remote');
  });

  it.each([
    [0, 1_000],
    [-1, 1_000],
    [Number.NaN, 30_000],
    [Number.POSITIVE_INFINITY, 30_000],
  ])(
    'clamps invalid retryDelayMs %s instead of creating an immediate retry loop',
    async (retryDelayMs, expectedDelayMs) => {
      vi.useFakeTimers();
      const reauthenticate = vi.fn().mockRejectedValue({ status: 0 });
      const { access, recovery } = setup({
        remoteRecovery: {
          availability: () => new Subject<boolean>(),
          retryDelayMs,
          reauthenticate,
        },
        isUnavailableError: () => true,
      });
      recovery.initialize();
      access.grantLocal();

      await vi.advanceTimersByTimeAsync(expectedDelayMs - 1);
      expect(reauthenticate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reauthenticate).toHaveBeenCalledOnce();
      vi.useRealTimers();
    },
  );

  it('does not resume or recreate a retry timer after destruction settles an in-flight recovery', async () => {
    vi.useFakeTimers();
    let rejectRecovery: ((error: unknown) => void) | undefined;
    const activate = vi.fn(async () => true);
    const reauthenticate = vi.fn(
      () =>
        new Promise<KitRemoteAccessRecovery>((_resolve, reject) => {
          rejectRecovery = reject;
        }),
    );
    const { access, recovery } = setup({
      remoteRecovery: {
        availability: () => new Subject<boolean>(),
        retryDelayMs: 1_000,
        reauthenticate,
      },
      isUnavailableError: () => true,
    });
    recovery.initialize();
    access.grantLocal();
    const pending = recovery.recover();

    TestBed.resetTestingModule();
    rejectRecovery?.({ status: 0 });
    await pending;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    expect(access.mode).toBe('local');
    vi.useRealTimers();
  });

  it('does not restore remote access after a newer access transition invalidates recovery', async () => {
    let resolveReauthentication: ((value: KitRemoteAccessRecovery) => void) | undefined;
    const activate = vi.fn(async () => true);
    const resume = vi.fn(async () => undefined);
    const { access, recovery } = setup({
      remoteRecovery: {
        availability: () => new Subject<boolean>(),
        reauthenticate: () =>
          new Promise<KitRemoteAccessRecovery>((resolve) => {
            resolveReauthentication = resolve;
          }),
      },
    });
    access.grantLocal();

    const pending = recovery.recover();
    access.clear();
    resolveReauthentication?.({ activate, resume });
    await pending;

    expect(access.mode).toBe('none');
    expect(activate).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('does not commit an identity when logout completes while activation is waiting', async () => {
    let releaseActivation: (() => void) | undefined;
    let activationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      activationStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let manifest: string | null = null;
    let localSession: string | null = null;
    let remoteSession: string | null = null;
    const { access, recovery } = setup({
      remoteRecovery: {
        availability: () => new Subject<boolean>(),
        reauthenticate: async () => ({
          activate: async (lease) => {
            activationStarted?.();
            await gate;
            if (!lease.isCurrent()) return false;
            manifest = localSession = remoteSession = 'old-user';
            return true;
          },
          resume: async () => undefined,
        }),
      },
    });
    access.grantLocal();

    const pending = recovery.recover();
    await started;
    access.clear();
    manifest = localSession = remoteSession = null;
    releaseActivation?.();
    await pending;

    expect(access.mode).toBe('none');
    expect(manifest).toBeNull();
    expect(localSession).toBeNull();
    expect(remoteSession).toBeNull();
  });

  it('preserves a newer identity when an older activation is released afterward', async () => {
    let releaseOld: (() => void) | undefined;
    let oldStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let manifest: string | null = null;
    const oldResume = vi.fn(async () => undefined);
    const { access, recovery } = setup({
      remoteRecovery: {
        availability: () => new Subject<boolean>(),
        reauthenticate: async () => ({
          activate: async (lease) => {
            oldStarted?.();
            await gate;
            if (!lease.isCurrent()) return false;
            manifest = 'old-user';
            return true;
          },
          resume: oldResume,
        }),
      },
    });
    access.grantLocal();

    const oldRecovery = recovery.recover();
    await started;
    access.beginTransition();
    manifest = 'new-user';
    access.grantRemote();
    releaseOld?.();
    await oldRecovery;

    expect(manifest).toBe('new-user');
    expect(access.mode).toBe('remote');
    expect(oldResume).not.toHaveBeenCalled();
  });
});
