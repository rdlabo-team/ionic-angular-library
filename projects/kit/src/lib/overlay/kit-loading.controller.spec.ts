import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LoadingController } from '@ionic/angular/standalone';

import { KitLoadingController } from './kit-loading.controller';

// ---------------------------------------------------------------------------
// Fake loading element factories
// ---------------------------------------------------------------------------
function fakeLoading() {
  return {
    present: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
  };
}

// A loading whose present() stays pending until we resolve it, to reproduce a dismiss that arrives
// mid-presentation.
function deferredLoading() {
  let resolvePresent!: () => void;
  const loading = {
    present: vi.fn().mockReturnValue(new Promise<void>((r) => (resolvePresent = r))),
    dismiss: vi.fn().mockResolvedValue(undefined),
  };
  return { loading, resolvePresent: () => resolvePresent() };
}

function setup(loading: ReturnType<typeof fakeLoading> = fakeLoading()) {
  const loadingCtrl = { create: vi.fn().mockResolvedValue(loading) };

  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), KitLoadingController, { provide: LoadingController, useValue: loadingCtrl }],
  });

  return { controller: TestBed.inject(KitLoadingController), loadingCtrl, loading };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('KitLoadingController', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('presents a single indicator and passes options through to create', async () => {
    const { controller, loadingCtrl, loading } = setup();
    await controller.presentLoading({ message: 'Loading…' });
    expect(loadingCtrl.create).toHaveBeenCalledOnce();
    expect(loadingCtrl.create).toHaveBeenCalledWith({ message: 'Loading…' });
    expect(loading.present).toHaveBeenCalledOnce();
    await controller.dismissLoading();
  });

  it('shows one indicator for concurrent presents and dismisses only after the last release', async () => {
    const { controller, loadingCtrl, loading } = setup();
    await controller.presentLoading();
    await controller.presentLoading();
    expect(loadingCtrl.create).toHaveBeenCalledOnce();

    await controller.dismissLoading();
    expect(loading.dismiss).not.toHaveBeenCalled(); // one reference still outstanding

    await controller.dismissLoading();
    expect(loading.dismiss).toHaveBeenCalledOnce();
  });

  it('is a no-op when dismissing while nothing is loading', async () => {
    const { controller, loadingCtrl, loading } = setup();
    await controller.dismissLoading();
    expect(loadingCtrl.create).not.toHaveBeenCalled();
    expect(loading.dismiss).not.toHaveBeenCalled();
  });

  it('shows nothing when a present is immediately balanced by a dismiss', async () => {
    const { controller, loadingCtrl } = setup();
    const p = controller.presentLoading();
    const d = controller.dismissLoading();
    await Promise.all([p, d]);
    expect(loadingCtrl.create).not.toHaveBeenCalled();
  });

  it('does not orphan the indicator when dismiss arrives before present() settles', async () => {
    const deferred = deferredLoading();
    const { controller, loadingCtrl } = setup(deferred.loading);

    const p1 = controller.presentLoading(); // create resolves, then present() is left pending
    // Wait until we are genuinely mid-presentation (present() called but not settled), so the dismiss
    // lands inside the create→present window — the exact race a naive ref-count would orphan.
    await vi.waitFor(() => expect(deferred.loading.present).toHaveBeenCalled());

    const p2 = controller.dismissLoading(); // count 0 → queued behind the still-pending present
    deferred.resolvePresent(); // present() settles → present task finishes → queued dismiss runs
    await Promise.all([p1, p2]);

    expect(loadingCtrl.create).toHaveBeenCalledOnce();
    expect(deferred.loading.present).toHaveBeenCalledOnce();
    // The key assertion: the indicator is torn down after present() settled, not left orphaned.
    expect(deferred.loading.dismiss).toHaveBeenCalledOnce();
  });

  it('creates a fresh indicator on a new cycle after full dismissal', async () => {
    const { controller, loadingCtrl } = setup();
    await controller.presentLoading();
    await controller.dismissLoading();
    await controller.presentLoading();
    expect(loadingCtrl.create).toHaveBeenCalledTimes(2);
    await controller.dismissLoading();
  });

  it('a failed present rolls back its reference and does not wedge later operations', async () => {
    const { controller, loadingCtrl, loading } = setup();
    loadingCtrl.create.mockRejectedValueOnce(new Error('boom'));

    // The failed reference is rolled back internally — no compensating dismissLoading() is needed.
    await expect(controller.presentLoading()).rejects.toThrow('boom');

    loadingCtrl.create.mockResolvedValue(loading);
    await controller.presentLoading();
    expect(loading.present).toHaveBeenCalledOnce();

    // A single dismiss tears the indicator down: proof the counter is balanced (not stuck at 1).
    await controller.dismissLoading();
    expect(loading.dismiss).toHaveBeenCalledOnce();
  });
});
