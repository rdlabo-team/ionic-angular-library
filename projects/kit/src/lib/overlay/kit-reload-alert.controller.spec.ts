import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController } from '@ionic/angular/standalone';

import { KitReloadAlertController } from './kit-reload-alert.controller';
import { provideKitOverlay } from './overlay-config';

const TEST_LABELS = { close: 'Close', cancel: 'Cancel' };
const OPTS = { header: 'Network error', message: 'Reload? (0)', okText: 'Reload' };

function fakeAlert() {
  let dismissResolve: () => void = () => undefined;
  return {
    present: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    // onDidDismiss resolves when we trigger it, mirroring Ionic's lifecycle.
    onDidDismiss: vi.fn().mockReturnValue(new Promise<void>((r) => (dismissResolve = r))),
    triggerDismiss: () => dismissResolve(),
  };
}

function setup(alert = fakeAlert()) {
  const alertCtrl = { create: vi.fn().mockResolvedValue(alert) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      KitReloadAlertController,
      provideKitOverlay({ labels: TEST_LABELS }),
      { provide: AlertController, useValue: alertCtrl },
    ],
  });
  return { controller: TestBed.inject(KitReloadAlertController), alertCtrl, alert };
}

describe('KitReloadAlertController', () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    document.body.innerHTML = '';
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('presents with backdrop lock and a cancel(role)/reload button pair', async () => {
    const { controller, alertCtrl } = setup();
    await controller.present(OPTS);
    const args = alertCtrl.create.mock.calls[0][0];
    expect(args.backdropDismiss).toBe(false);
    expect(args.buttons[0]).toMatchObject({ text: 'Cancel', role: 'cancel' });
    expect(args.buttons[1].text).toBe('Reload');
  });

  it('reloads the page from the confirm button handler', async () => {
    const { controller, alertCtrl } = setup();
    await controller.present(OPTS);
    const args = alertCtrl.create.mock.calls[0][0];
    args.buttons[1].handler();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('de-dups: a second present while showing is a no-op', async () => {
    const { controller, alertCtrl } = setup();
    await controller.present(OPTS);
    await controller.present(OPTS);
    expect(alertCtrl.create).toHaveBeenCalledTimes(1);
  });

  it('does not present when an ion-alert already exists in the DOM', async () => {
    document.body.appendChild(document.createElement('ion-alert'));
    const { controller, alertCtrl } = setup();
    await controller.present(OPTS);
    expect(alertCtrl.create).not.toHaveBeenCalled();
  });

  it('dismiss() dismisses the tracked alert (auto-dismiss on reconnect)', async () => {
    const { controller, alert } = setup();
    await controller.present(OPTS);
    await controller.dismiss();
    expect(alert.dismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss() is a no-op when nothing is showing', async () => {
    const { controller, alert } = setup();
    await controller.dismiss();
    expect(alert.dismiss).not.toHaveBeenCalled();
  });

  it('allows presenting again after the alert is dismissed', async () => {
    const first = fakeAlert();
    const { controller, alertCtrl } = setup(first);
    await controller.present(OPTS);
    await controller.dismiss();
    first.triggerDismiss();
    await Promise.resolve();
    await controller.present(OPTS);
    expect(alertCtrl.create).toHaveBeenCalledTimes(2);
  });
});
