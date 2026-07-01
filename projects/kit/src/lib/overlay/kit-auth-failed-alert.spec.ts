import type { AlertController } from '@ionic/angular/standalone';
import { kitPresentAuthFailedAlert } from './kit-auth-failed-alert';

const OPTS = { header: 'ログインできませんでした', subHeader: 'E_AUTH', message: '詳細メッセージ', closeText: '閉じる' };

describe('kitPresentAuthFailedAlert', () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
  });

  function fakeAlertCtrl() {
    const alert = { present: vi.fn().mockResolvedValue(undefined) };
    const create = vi.fn().mockResolvedValue(alert);
    return { create } as unknown as AlertController & { create: ReturnType<typeof vi.fn> };
  }

  it('creates the alert with header/subHeader/message and a single close button, then presents', async () => {
    const alertCtrl = fakeAlertCtrl();
    await kitPresentAuthFailedAlert(alertCtrl, OPTS);
    const args = alertCtrl.create.mock.calls[0][0];
    expect(args).toMatchObject({ header: OPTS.header, subHeader: OPTS.subHeader, message: OPTS.message });
    expect(args.buttons).toHaveLength(1);
    expect(args.buttons[0]).toMatchObject({ text: '閉じる', role: 'cancel' });
    const alert = await alertCtrl.create.mock.results[0].value;
    expect(alert.present).toHaveBeenCalledTimes(1);
  });

  it('reloads the page from the close button handler', async () => {
    const alertCtrl = fakeAlertCtrl();
    await kitPresentAuthFailedAlert(alertCtrl, OPTS);
    const args = alertCtrl.create.mock.calls[0][0];
    expect(reload).not.toHaveBeenCalled();
    args.buttons[0].handler();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
