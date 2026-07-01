import { ElementRef } from '@angular/core';

import { kitCreateDidEnter } from './ionic-view-enter';

function hostRef() {
  return new ElementRef(document.createElement('div'));
}

describe('kitCreateDidEnter', () => {
  it('starts with false before any lifecycle event', () => {
    const seen: boolean[] = [];
    const sub = kitCreateDidEnter(hostRef()).subscribe((v) => seen.push(v));
    expect(seen).toEqual([false]);
    sub.unsubscribe();
  });

  it('emits true on ionViewDidEnter and false on will-enter/will-leave', () => {
    const el = hostRef();
    const seen: boolean[] = [];
    const sub = kitCreateDidEnter(el).subscribe((v) => seen.push(v));
    el.nativeElement.dispatchEvent(new Event('ionViewDidEnter'));
    el.nativeElement.dispatchEvent(new Event('ionViewWillLeave'));
    el.nativeElement.dispatchEvent(new Event('ionViewWillEnter'));
    expect(seen).toEqual([false, true, false, false]);
    sub.unsubscribe();
  });

  it('removes listeners on unsubscribe', () => {
    const el = hostRef();
    const seen: boolean[] = [];
    const sub = kitCreateDidEnter(el).subscribe((v) => seen.push(v));
    sub.unsubscribe();
    el.nativeElement.dispatchEvent(new Event('ionViewDidEnter'));
    expect(seen).toEqual([false]); // no emission after unsubscribe
  });
});
