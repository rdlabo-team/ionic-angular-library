import { Component, input, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController, ModalController, PopoverController, ToastController } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';

import { KitOverlayController } from './kit-overlay.controller';
import { KIT_OVERLAY_CONFIG, provideKitOverlay } from './overlay-config';

// ---------------------------------------------------------------------------
// Mock Capacitor — KitOverlayController imports Capacitor/Keyboard for the
// watchKeyboard feature; we stub them so no native APIs are called in jsdom.
// ---------------------------------------------------------------------------
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn().mockReturnValue(false),
    getPlatform: vi.fn().mockReturnValue('web'),
  },
  registerPlugin: vi.fn().mockReturnValue({}),
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock('@capacitor/haptics', () => ({
  Haptics: { impact: vi.fn().mockResolvedValue(undefined) },
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM', Heavy: 'HEAVY' },
}));

// ---------------------------------------------------------------------------
// Fake overlay element factory
// ---------------------------------------------------------------------------
type Role = string | undefined;

function fakeOverlay(role: Role = undefined, data: unknown = undefined) {
  return {
    present: vi.fn().mockResolvedValue(undefined),
    onWillDismiss: vi.fn().mockResolvedValue({ role, data }),
    onDidDismiss: vi.fn().mockResolvedValue({ role, data }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TEST_LABELS = { close: 'Close', cancel: 'Cancel' };

function setup({
  modalOverlay = fakeOverlay(),
  popoverOverlay = fakeOverlay(),
  toastOverlay = fakeOverlay(),
  alertOverlay = fakeOverlay(),
}: {
  modalOverlay?: ReturnType<typeof fakeOverlay>;
  popoverOverlay?: ReturnType<typeof fakeOverlay>;
  toastOverlay?: ReturnType<typeof fakeOverlay>;
  alertOverlay?: ReturnType<typeof fakeOverlay>;
} = {}) {
  const modalCtrl = { create: vi.fn().mockResolvedValue(modalOverlay) };
  const popoverCtrl = { create: vi.fn().mockResolvedValue(popoverOverlay) };
  const toastCtrl = { create: vi.fn().mockResolvedValue(toastOverlay) };
  const alertCtrl = { create: vi.fn().mockResolvedValue(alertOverlay) };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      KitOverlayController,
      provideKitOverlay({ labels: TEST_LABELS }),
      { provide: ModalController, useValue: modalCtrl },
      { provide: PopoverController, useValue: popoverCtrl },
      { provide: ToastController, useValue: toastCtrl },
      { provide: AlertController, useValue: alertCtrl },
    ],
  });

  return {
    controller: TestBed.inject(KitOverlayController),
    modalCtrl,
    popoverCtrl,
    toastCtrl,
    alertCtrl,
    modalOverlay,
    popoverOverlay,
    toastOverlay,
    alertOverlay,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('KitOverlayController', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ---- alertConfirm ---------------------------------------------------------
  describe('alertConfirm', () => {
    const opts = { header: 'Confirm', message: 'Are you sure?', okText: 'OK' };

    it("returns true when onWillDismiss role === 'confirm'", async () => {
      const { controller } = setup({ alertOverlay: fakeOverlay('confirm') });
      const result = await controller.alertConfirm(opts);
      expect(result).toBe(true);
    });

    it("returns false when onWillDismiss role === 'cancel'", async () => {
      const { controller } = setup({ alertOverlay: fakeOverlay('cancel') });
      const result = await controller.alertConfirm(opts);
      expect(result).toBe(false);
    });

    it('returns false when role is undefined (backdrop dismiss)', async () => {
      const { controller } = setup({ alertOverlay: fakeOverlay(undefined) });
      const result = await controller.alertConfirm(opts);
      expect(result).toBe(false);
    });

    it('creates the alert with the correct buttons (cancel + confirm)', async () => {
      const { controller, alertCtrl } = setup({ alertOverlay: fakeOverlay('confirm') });
      await controller.alertConfirm(opts);
      const createArgs = alertCtrl.create.mock.calls[0][0];
      const roles = (createArgs.buttons as { role: string }[]).map((b) => b.role);
      expect(roles).toContain('cancel');
      expect(roles).toContain('confirm');
    });

    it('uses the injected cancel label', async () => {
      const { controller, alertCtrl } = setup({ alertOverlay: fakeOverlay('cancel') });
      await controller.alertConfirm(opts);
      const createArgs = alertCtrl.create.mock.calls[0][0];
      const cancelBtn = (createArgs.buttons as { text: string; role: string }[]).find((b) => b.role === 'cancel');
      expect(cancelBtn?.text).toBe(TEST_LABELS.cancel);
    });
  });

  // ---- alertClose -----------------------------------------------------------
  describe('alertClose', () => {
    it('creates and presents an alert then waits for dismiss', async () => {
      const overlay = fakeOverlay();
      const { controller, alertCtrl } = setup({ alertOverlay: overlay });
      await controller.alertClose({ header: 'Info', message: 'Done' });
      expect(alertCtrl.create).toHaveBeenCalledOnce();
      expect(overlay.present).toHaveBeenCalledOnce();
      expect(overlay.onWillDismiss).toHaveBeenCalledOnce();
    });

    it('uses the injected close label for the button', async () => {
      const { controller, alertCtrl } = setup();
      await controller.alertClose({ header: 'H', message: 'M' });
      const createArgs = alertCtrl.create.mock.calls[0][0];
      expect(createArgs.buttons).toContain(TEST_LABELS.close);
    });
  });

  // ---- alert stacking guard -------------------------------------------------
  describe('alert stacking guard', () => {
    // Build an alert overlay whose onWillDismiss stays pending until we resolve it,
    // so a first alert is still "presenting" when a concurrent call is made.
    function deferredAlert() {
      let resolveDismiss!: (v: { role: Role }) => void;
      const overlay = {
        present: vi.fn().mockResolvedValue(undefined),
        onWillDismiss: vi.fn().mockReturnValue(new Promise<{ role: Role }>((r) => (resolveDismiss = r))),
        onDidDismiss: vi.fn().mockResolvedValue({ role: undefined, data: undefined }),
      };
      return { overlay, dismiss: () => resolveDismiss({ role: 'confirm' }) };
    }

    it('no-ops a concurrent alertClose while one is presenting', async () => {
      const first = deferredAlert();
      const { controller, alertCtrl } = setup({ alertOverlay: first.overlay });
      const p = controller.alertClose({ header: 'H', message: 'M' }); // stays pending
      await controller.alertClose({ header: 'H2', message: 'M2' }); // guarded → immediate no-op
      expect(alertCtrl.create).toHaveBeenCalledOnce();
      first.dismiss();
      await p;
    });

    it('returns false for a concurrent alertConfirm while one is presenting', async () => {
      const first = deferredAlert();
      const { controller, alertCtrl } = setup({ alertOverlay: first.overlay });
      const p = controller.alertConfirm({ header: 'H', message: 'M', okText: 'OK' });
      const blocked = await controller.alertConfirm({ header: 'H2', message: 'M2', okText: 'OK' });
      expect(blocked).toBe(false);
      expect(alertCtrl.create).toHaveBeenCalledOnce();
      first.dismiss();
      await p;
    });

    it('allows a new alert after the previous one dismisses', async () => {
      const first = deferredAlert();
      const { controller, alertCtrl } = setup({ alertOverlay: first.overlay });
      const p = controller.alertClose({ header: 'H', message: 'M' });
      first.dismiss();
      await p;
      await controller.alertClose({ header: 'H2', message: 'M2' });
      expect(alertCtrl.create).toHaveBeenCalledTimes(2);
    });
  });

  // ---- presentToast ---------------------------------------------------------
  describe('presentToast', () => {
    it('applies kit defaults (position=bottom, duration=2000) and presents the toast', async () => {
      const overlay = fakeOverlay();
      const { controller, toastCtrl } = setup({ toastOverlay: overlay });
      await controller.presentToast({ message: 'Hello' });
      const createArgs = toastCtrl.create.mock.calls[0][0];
      expect(createArgs.position).toBe('bottom');
      expect(createArgs.duration).toBe(2000);
      expect(overlay.present).toHaveBeenCalledOnce();
    });

    it('caller options override kit defaults', async () => {
      const { controller, toastCtrl } = setup();
      await controller.presentToast({ message: 'Hi', position: 'bottom', duration: 5000 });
      const createArgs = toastCtrl.create.mock.calls[0][0];
      expect(createArgs.position).toBe('bottom');
      expect(createArgs.duration).toBe(5000);
    });

    it('auto-anchors a bottom toast above a visible ion-tab-bar', async () => {
      const tabBar = document.createElement('ion-tab-bar');
      tabBar.getBoundingClientRect = () => ({ height: 50 }) as DOMRect;
      document.body.appendChild(tabBar);
      try {
        const { controller, toastCtrl } = setup();
        await controller.presentToast({ message: 'Hi' });
        expect(toastCtrl.create.mock.calls[0][0].positionAnchor).toBe(tabBar);
      } finally {
        document.body.removeChild(tabBar);
      }
    });

    it('does not anchor when no tab bar is present', async () => {
      const { controller, toastCtrl } = setup();
      await controller.presentToast({ message: 'Hi' });
      expect(toastCtrl.create.mock.calls[0][0].positionAnchor).toBeUndefined();
    });

    it('does not override an explicit positionAnchor', async () => {
      const tabBar = document.createElement('ion-tab-bar');
      tabBar.getBoundingClientRect = () => ({ height: 50 }) as DOMRect;
      document.body.appendChild(tabBar);
      const custom = document.createElement('div');
      try {
        const { controller, toastCtrl } = setup();
        await controller.presentToast({ message: 'Hi', positionAnchor: custom });
        expect(toastCtrl.create.mock.calls[0][0].positionAnchor).toBe(custom);
      } finally {
        document.body.removeChild(tabBar);
      }
    });

    it('includes the close label button from config', async () => {
      const { controller, toastCtrl } = setup();
      await controller.presentToast({ message: 'Test' });
      const createArgs = toastCtrl.create.mock.calls[0][0];
      expect(createArgs.buttons).toContain(TEST_LABELS.close);
    });

    it('returns the toast element', async () => {
      const overlay = fakeOverlay();
      const { controller, toastCtrl } = setup({ toastOverlay: overlay });
      toastCtrl.create.mockResolvedValue(overlay);
      const result = await controller.presentToast({ message: 'Test' });
      expect(result).toBe(overlay);
    });
  });

  // ---- presentModal ---------------------------------------------------------
  describe('presentModal', () => {
    class FakeComponent {}

    it('creates the modal with the given component and props', async () => {
      const { controller, modalCtrl } = setup({ modalOverlay: fakeOverlay(undefined, { result: 42 }) });
      await controller.presentModal(FakeComponent, { id: 1 });
      const createArgs = modalCtrl.create.mock.calls[0][0];
      expect(createArgs.component).toBe(FakeComponent);
      expect(createArgs.componentProps).toEqual({ id: 1 });
    });

    it('returns the dismiss data when the component declares modalReturn', async () => {
      @Component({ template: '' })
      class ResultModal {
        declare static modalReturn: { selected: string };
      }
      const dismissData = { selected: 'foo' };
      const { controller } = setup({ modalOverlay: fakeOverlay(undefined, dismissData) });
      const result = await controller.presentModal(ResultModal); // typed `{ selected: string } | undefined`
      expect(result?.selected).toBe('foo');
      expect(result).toEqual(dismissData);
    });

    it('type: a modal without modalReturn resolves to void', async () => {
      @Component({ template: '' })
      class NoReturnModal {}
      const { controller } = setup({ modalOverlay: fakeOverlay() });
      const result = await controller.presentModal(NoReturnModal);
      // `result` is `void`: it is assignable to void, and reading a property off it must not compile.
      const assertVoid: void = result;
      expect(assertVoid).toBeUndefined();
      // @ts-expect-error — a void result carries no dismiss data.
      result?.anything;
    });

    it('presents the modal', async () => {
      const overlay = fakeOverlay(undefined, null);
      const { controller } = setup({ modalOverlay: overlay });
      await controller.presentModal(FakeComponent);
      expect(overlay.present).toHaveBeenCalledOnce();
    });

    it('waits for onDidDismiss before returning', async () => {
      const overlay = fakeOverlay(undefined, 'done');
      const { controller } = setup({ modalOverlay: overlay });
      await controller.presentModal(FakeComponent);
      expect(overlay.onDidDismiss).toHaveBeenCalledOnce();
    });

    it('infers props from input() fields and the return type from static modalReturn', async () => {
      @Component({ template: '' })
      class TypedModal {
        declare static modalReturn: { saved: boolean };
        readonly id = input.required<number>(); // required input → required prop
        readonly note = input<string>(); // default-less input() → optional prop
      }
      const { controller, modalCtrl } = setup({ modalOverlay: fakeOverlay(undefined, { saved: true }) });
      // `{ id: 1 }` is type-checked against the inferred props; `result` is typed
      // `{ saved: boolean } | undefined`, so `result?.saved` only compiles when inference is wired up.
      const result = await controller.presentModal(TypedModal, { id: 1, note: 'hi' });
      expect(modalCtrl.create.mock.calls[0][0].componentProps).toEqual({ id: 1, note: 'hi' });
      expect(result?.saved).toBe(true);
    });

    it('type: required input makes its prop required and a defaulted input is required too', async () => {
      @Component({ template: '' })
      class RequiredModal {
        readonly id = input.required<number>();
        readonly count = input<number>(0); // defaulted input() is (safely) treated as required
      }
      const { controller } = setup({ modalOverlay: fakeOverlay() });

      // @ts-expect-error — `id` is required, omitting the props object must not compile.
      await controller.presentModal(RequiredModal);
      // @ts-expect-error — `count` (defaulted input) is treated as required, so it cannot be omitted.
      await controller.presentModal(RequiredModal, { id: 1 });

      await controller.presentModal(RequiredModal, { id: 1, count: 5 }); // fully specified → ok
    });

    it('type: a component with only optional inputs allows omitting the props argument', async () => {
      @Component({ template: '' })
      class OptionalModal {
        readonly note = input<string>();
      }
      const { controller } = setup({ modalOverlay: fakeOverlay() });
      await controller.presentModal(OptionalModal); // props argument optional → ok
      await controller.presentModal(OptionalModal, { note: 'hi' }); // still accepts the props
    });
  });

  // ---- presentPopover -------------------------------------------------------
  describe('presentPopover', () => {
    class FakeComponent {}

    it('creates the popover with the component, props, and extra options; presents; returns data', async () => {
      const { controller, popoverCtrl, popoverOverlay } = setup({ popoverOverlay: fakeOverlay(undefined, { picked: 'x' }) });
      const event = {} as Event;
      const result = await controller.presentPopover<{ picked: string }>(FakeComponent, { id: 1 }, { event });
      const createArgs = popoverCtrl.create.mock.calls[0][0];
      expect(createArgs.component).toBe(FakeComponent);
      expect(createArgs.componentProps).toEqual({ id: 1 });
      expect(createArgs.event).toBe(event);
      expect(popoverOverlay.present).toHaveBeenCalledOnce();
      expect(result).toEqual({ picked: 'x' });
    });
  });

  // ---- haptic feedback ------------------------------------------------------
  describe('haptic feedback (native platform)', () => {
    class FakeComponent {}

    beforeEach(() => {
      vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
      vi.mocked(Haptics.impact).mockClear();
    });
    afterEach(() => {
      vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    });

    it('fires haptic impact when presenting a modal', async () => {
      const { controller } = setup();
      await controller.presentModal(FakeComponent);
      expect(Haptics.impact).toHaveBeenCalledOnce();
    });

    it('fires haptic impact when presenting a popover', async () => {
      const { controller } = setup();
      await controller.presentPopover(FakeComponent);
      expect(Haptics.impact).toHaveBeenCalledOnce();
    });

    it('fires haptic impact when presenting a toast', async () => {
      const { controller } = setup();
      await controller.presentToast({ message: 'Hi' });
      expect(Haptics.impact).toHaveBeenCalledOnce();
    });
  });

  // ---- provideKitOverlay / KIT_OVERLAY_CONFIG -------------------------------
  describe('provideKitOverlay', () => {
    it('injects the configured labels', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), provideKitOverlay({ labels: { close: 'Fermer', cancel: 'Annuler' } })],
      });
      const cfg = TestBed.inject(KIT_OVERLAY_CONFIG);
      expect(cfg.labels.close).toBe('Fermer');
      expect(cfg.labels.cancel).toBe('Annuler');
    });
  });
});
