import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { mountViewModel } from './component';

@Component({
  template: '',
})
class MountHostComponent {
  readonly value = signal('initial');
  readonly onMount = vi.fn();
  readonly vm = mountViewModel(this, this.onMount);
}

describe('mountViewModel', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('returns the original host for ViewModel access', () => {
    const fixture = TestBed.createComponent(MountHostComponent);

    expect(fixture.componentInstance.vm).toBe(fixture.componentInstance);
  });

  it('runs the mount callback after the first render and only once', () => {
    const fixture = TestBed.createComponent(MountHostComponent);
    const host = fixture.componentInstance;

    expect(host.onMount).not.toHaveBeenCalled();

    fixture.detectChanges();

    expect(host.onMount).toHaveBeenCalledOnce();

    fixture.detectChanges();

    expect(host.onMount).toHaveBeenCalledOnce();
  });

  it('accepts a host without registering a mount callback', () => {
    const host = { value: signal(1) };

    expect(mountViewModel(host)).toBe(host);
  });
});
