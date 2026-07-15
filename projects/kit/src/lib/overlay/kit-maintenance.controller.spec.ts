import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController } from '@ionic/angular/standalone';

import { KitMaintenanceController } from './kit-maintenance.controller';

const OPTS = {
  header: 'メンテナンス中です',
  message: 'しばらくお待ちください。',
  waitUrl: 'https://api.example/public/maintenance/wait',
};

type FakeSource = {
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onerror: ((ev: Event) => void) | null;
  onopen: ((ev: Event) => void) | null;
  trigger: (type: string) => void;
};

function fakeAlert() {
  let dismissResolve: () => void = () => undefined;
  return {
    present: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    onDidDismiss: vi.fn().mockReturnValue(new Promise<void>((r) => (dismissResolve = r))),
    triggerDismiss: () => dismissResolve(),
  };
}

function fakeEventSource(): FakeSource {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: vi.fn((type: string, handler: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    }),
    close: vi.fn(),
    onerror: null,
    onopen: null,
    trigger(type: string) {
      for (const handler of listeners.get(type) ?? []) {
        handler();
      }
    },
  };
}

function setup(alert = fakeAlert(), source = fakeEventSource()) {
  const alertCtrl = { create: vi.fn().mockResolvedValue(alert) };
  const EventSourceMock = vi.fn(function EventSourceMock() {
    return source;
  });
  vi.stubGlobal('EventSource', EventSourceMock);

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      KitMaintenanceController,
      { provide: AlertController, useValue: alertCtrl },
    ],
  });
  return {
    controller: TestBed.inject(KitMaintenanceController),
    alertCtrl,
    alert,
    source,
    EventSourceMock,
  };
}

describe('KitMaintenanceController', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('presents with backdrop lock, no buttons, and opens EventSource on waitUrl', async () => {
    const { controller, alertCtrl, EventSourceMock } = setup();
    await controller.present(OPTS);
    const args = alertCtrl.create.mock.calls[0][0];
    expect(args.backdropDismiss).toBe(false);
    expect(args.buttons).toEqual([]);
    expect(args.cssClass).toBe('kit-maintenance-alert');
    expect(EventSourceMock).toHaveBeenCalledWith(OPTS.waitUrl);
  });

  it('de-dups: a second present while showing is a no-op', async () => {
    const { controller, alertCtrl, EventSourceMock } = setup();
    await controller.present(OPTS);
    await controller.present(OPTS);
    expect(alertCtrl.create).toHaveBeenCalledTimes(1);
    expect(EventSourceMock).toHaveBeenCalledTimes(1);
  });

  it('dismisses when the wait stream emits ended', async () => {
    const { controller, alert, source } = setup();
    await controller.present(OPTS);
    source.trigger('ended');
    await Promise.resolve();
    expect(alert.dismiss).toHaveBeenCalledTimes(1);
    expect(source.close).toHaveBeenCalled();
  });

  it('dismiss() is a no-op when nothing is showing', async () => {
    const { controller, alert } = setup();
    await controller.dismiss();
    expect(alert.dismiss).not.toHaveBeenCalled();
  });

  it('allows presenting again after dismiss', async () => {
    const first = fakeAlert();
    const { controller, alertCtrl, source } = setup(first);
    await controller.present(OPTS);
    source.trigger('ended');
    await Promise.resolve();
    first.triggerDismiss();
    await Promise.resolve();
    await controller.present(OPTS);
    expect(alertCtrl.create).toHaveBeenCalledTimes(2);
  });
});
