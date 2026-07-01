import { disableHandler } from './dom';

describe('disableHandler', () => {
  function clickEvent() {
    const button = document.createElement('button');
    return { button, event: { target: button } as unknown as Event };
  }

  it('disables the button while the work runs and re-enables it after', async () => {
    const { button, event } = clickEvent();
    let disabledDuringWork = false;
    const work = Promise.resolve().then(() => {
      disabledDuringWork = button.disabled;
    });
    await disableHandler(event, work);
    expect(disabledDuringWork).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it('re-enables the button even when the work rejects', async () => {
    const { button, event } = clickEvent();
    await disableHandler(event, Promise.reject(new Error('boom')));
    expect(button.disabled).toBe(false);
  });
});
