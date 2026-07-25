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
