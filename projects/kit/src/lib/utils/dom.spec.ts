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

  it('prevents form navigation and disables a native submitter', async () => {
    const form = document.createElement('form');
    const button = document.createElement('button');
    button.type = 'submit';
    form.appendChild(button);
    const preventDefault = vi.fn();
    const event = {
      type: 'submit',
      target: form,
      currentTarget: form,
      submitter: button,
      preventDefault,
    } as unknown as SubmitEvent;
    let disabledDuringWork = false;

    await disableHandler(
      event,
      Promise.resolve().then(() => (disabledDuringWork = button.disabled)),
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(disabledDuringWork).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it('disables an external ion-button associated with the submitted form', async () => {
    const form = document.createElement('form');
    const proxy = document.createElement('button');
    proxy.type = 'submit';
    proxy.style.display = 'none';
    form.appendChild(proxy);
    const ionButton = document.createElement('ion-button') as HTMLElement & {
      disabled: boolean;
      form: HTMLFormElement;
    };
    ionButton.setAttribute('type', 'submit');
    ionButton.disabled = false;
    ionButton.form = form;
    document.body.append(form, ionButton);
    const event = {
      type: 'submit',
      target: form,
      currentTarget: form,
      submitter: proxy,
      preventDefault: vi.fn(),
    } as unknown as SubmitEvent;
    let disabledDuringWork = false;

    await disableHandler(
      event,
      Promise.resolve().then(() => (disabledDuringWork = ionButton.disabled)),
    );

    expect(disabledDuringWork).toBe(true);
    expect(ionButton.disabled).toBe(false);
    form.remove();
    ionButton.remove();
  });

  it('restores the original disabled state of every submitter for the form', async () => {
    const form = document.createElement('form');
    const first = document.createElement('ion-button') as HTMLElement & {
      disabled: boolean;
      form: HTMLFormElement;
    };
    const second = document.createElement('ion-button') as typeof first;
    [first, second].forEach((button) => {
      button.setAttribute('type', 'submit');
      button.form = form;
    });
    first.disabled = false;
    second.disabled = true;
    document.body.append(form, first, second);
    const event = {
      type: 'submit',
      target: form,
      submitter: document.createElement('button'),
      preventDefault: vi.fn(),
    } as unknown as SubmitEvent;

    await disableHandler(event, Promise.resolve());

    expect(first.disabled).toBe(false);
    expect(second.disabled).toBe(true);
    form.remove();
    first.remove();
    second.remove();
  });
});
