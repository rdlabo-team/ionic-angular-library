import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, FormField } from '@angular/forms/signals';
import { KitAuthInputDirective, type KitAuthInputMode } from './auth-input.directive';
import { KitStorageService } from '../storage/kit-storage.service';
import { KIT_LAST_AUTH_EMAIL_KEY } from '../storage/kit-auth-email-store';

/** In-memory stand-in for `KitStorageService`. */
class FakeStorage {
  readonly map = new Map<string, unknown>();
  get<T>(key: string): Promise<T | null> {
    return Promise.resolve((this.map.get(key) ?? null) as T | null);
  }
  set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

@Component({
  standalone: true,
  imports: [FormField, KitAuthInputDirective],
  template: `<input [formField]="f.email" [kitAuthInput]="mode()" />`,
})
class HostComponent {
  readonly mode = signal<KitAuthInputMode>('email');
  readonly model = signal<{ email: string }>({ email: '' });
  readonly f = form(this.model);
}

const setup = async (mode: KitAuthInputMode, initialEmail = '', seed?: string) => {
  const storage = new FakeStorage();
  if (seed !== undefined) {
    storage.map.set(KIT_LAST_AUTH_EMAIL_KEY, seed);
  }
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [{ provide: KitStorageService, useValue: storage }],
  });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.mode.set(mode);
  fixture.componentInstance.model.set({ email: initialEmail });
  fixture.detectChanges(); // runs ngOnInit → prefill
  await fixture.whenStable();
  await Promise.resolve();
  fixture.detectChanges();
  return { fixture, storage, host: fixture.componentInstance };
};

const fireIonChange = (fixture: { nativeElement: HTMLElement }, value: string) =>
  fixture.nativeElement
    .querySelector('input')!
    .dispatchEvent(new CustomEvent('ionChange', { detail: { value }, bubbles: true }));

describe('KitAuthInputDirective', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('prefill', () => {
    it('"email" seeds the empty field from storage', async () => {
      const { host } = await setup('email', '', 'saved@example.com');
      expect(host.f.email().value()).toBe('saved@example.com');
    });

    it('"email" does NOT clobber a field that is already filled (autofill wins)', async () => {
      const { host } = await setup('email', 'typed@example.com', 'saved@example.com');
      expect(host.f.email().value()).toBe('typed@example.com');
    });

    it('"email-remember" never prefills', async () => {
      const { host } = await setup('email-remember', '', 'saved@example.com');
      expect(host.f.email().value()).toBe('');
    });

    it('"autofill" never prefills', async () => {
      const { host } = await setup('autofill', '', 'saved@example.com');
      expect(host.f.email().value()).toBe('');
    });
  });

  describe('remember on ionChange', () => {
    it('persists a well-formed email in "email" mode', async () => {
      const { fixture, storage } = await setup('email');
      fireIonChange(fixture, 'new@example.com');
      await Promise.resolve();
      expect(storage.map.get(KIT_LAST_AUTH_EMAIL_KEY)).toBe('new@example.com');
    });

    it('persists a well-formed email in "email-remember" mode', async () => {
      const { fixture, storage } = await setup('email-remember');
      fireIonChange(fixture, 'signup@example.com');
      await Promise.resolve();
      expect(storage.map.get(KIT_LAST_AUTH_EMAIL_KEY)).toBe('signup@example.com');
    });

    it('does not persist a malformed address', async () => {
      const { fixture, storage } = await setup('email');
      fireIonChange(fixture, 'not-an-email');
      await Promise.resolve();
      expect(storage.map.has(KIT_LAST_AUTH_EMAIL_KEY)).toBe(false);
    });

    it('is inert in "autofill" mode', async () => {
      const { fixture, storage } = await setup('autofill');
      fireIonChange(fixture, 'x@example.com');
      await Promise.resolve();
      expect(storage.map.has(KIT_LAST_AUTH_EMAIL_KEY)).toBe(false);
    });
  });

  describe('forget on clear/invalid', () => {
    it('"email" forgets when cleared to empty', async () => {
      const { fixture, storage } = await setup('email', 'saved@example.com', 'saved@example.com');
      fireIonChange(fixture, '');
      await Promise.resolve();
      expect(storage.map.has(KIT_LAST_AUTH_EMAIL_KEY)).toBe(false);
    });

    it('"email" forgets on a whitespace-only / invalid value', async () => {
      const { fixture, storage } = await setup('email', '', 'saved@example.com');
      fireIonChange(fixture, '   ');
      await Promise.resolve();
      expect(storage.map.has(KIT_LAST_AUTH_EMAIL_KEY)).toBe(false);
    });

    it('"email-remember" does NOT forget when cleared (keeps a value remembered elsewhere)', async () => {
      const { fixture, storage } = await setup('email-remember', '', 'saved@example.com');
      fireIonChange(fixture, '');
      await Promise.resolve();
      expect(storage.map.get(KIT_LAST_AUTH_EMAIL_KEY)).toBe('saved@example.com');
    });
  });
});
