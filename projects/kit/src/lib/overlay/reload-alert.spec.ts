import { KitOverlayController } from './kit-overlay.controller';
import { kitPresentReloadAlert } from './reload-alert';

// ---------------------------------------------------------------------------
// kitPresentReloadAlert composes KitOverlayController.alertConfirm with an
// ion-alert de-dup guard and location.reload(); we stub all three.
// ---------------------------------------------------------------------------

const OPTS = { header: 'Network error', message: 'Reload? (0)', okText: 'Reload' };

function fakeOverlay(confirm: boolean) {
  return { alertConfirm: vi.fn().mockResolvedValue(confirm) } as unknown as KitOverlayController & {
    alertConfirm: ReturnType<typeof vi.fn>;
  };
}

describe('kitPresentReloadAlert', () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reload = vi.fn();
    // jsdom's location.reload is not writable; redefine it for the test.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    document.body.innerHTML = '';
  });

  it('reloads the page when the user confirms', async () => {
    const overlay = fakeOverlay(true);
    await kitPresentReloadAlert(overlay, OPTS);
    expect(overlay.alertConfirm).toHaveBeenCalledWith(OPTS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the user cancels', async () => {
    const overlay = fakeOverlay(false);
    await kitPresentReloadAlert(overlay, OPTS);
    expect(overlay.alertConfirm).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('suppresses stacking when an ion-alert is already present', async () => {
    document.body.appendChild(document.createElement('ion-alert'));
    const overlay = fakeOverlay(true);
    await kitPresentReloadAlert(overlay, OPTS);
    expect(overlay.alertConfirm).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
