import { signal } from '@angular/core';

import { kitChangeEventDisabled } from './ionic-scroll-event';

type ScrollEl = HTMLIonInfiniteScrollElement;

describe('kitChangeEventDisabled', () => {
  it('sets disabled on the held element', () => {
    const el = { disabled: false } as ScrollEl;
    const sig = signal<ScrollEl | null>(el);
    kitChangeEventDisabled(sig, true);
    expect(el.disabled).toBe(true);
  });

  it('can re-enable the element', () => {
    const el = { disabled: true } as ScrollEl;
    const sig = signal<ScrollEl | null>(el);
    kitChangeEventDisabled(sig, false);
    expect(el.disabled).toBe(false);
  });

  it('is a no-op when the signal holds no element', () => {
    const sig = signal<ScrollEl | null>(null);
    expect(() => kitChangeEventDisabled(sig, true)).not.toThrow();
    expect(sig()).toBeNull();
  });
});
