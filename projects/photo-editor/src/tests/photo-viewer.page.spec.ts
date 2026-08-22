import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { ModalController } from '@ionic/angular';
import { vi } from 'vitest';
import { testConfig } from '../../../util/test.config';
import { PhotoViewerPage } from '../../viewer/src/lib/photo-viewer.page';

class TestSwiperContainer extends HTMLElement {
  readonly initialize = vi.fn();
  readonly swiper = {
    activeIndex: 0,
    update: vi.fn(),
    zoom: { enable: vi.fn() },
  };
}

if (!customElements.get('swiper-container')) {
  customElements.define('swiper-container', TestSwiperContainer);
}
if (!customElements.get('swiper-slide')) {
  customElements.define('swiper-slide', class extends HTMLElement {});
}

describe('PhotoViewerPage', () => {
  let component: PhotoViewerPage;
  let fixture: ComponentFixture<PhotoViewerPage>;
  let componentRef: ComponentRef<PhotoViewerPage>;
  let modalCtrl: ModalController;
  let internals: {
    swiper: () => { nativeElement: { swiper: unknown } } | undefined;
    watchSwipe$: { unsubscribe: () => void };
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(PhotoViewerPage);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('imageUrls', []);
    componentRef.setInput('toolbarColorScheme', 'dark');
    fixture.detectChanges();
    modalCtrl = TestBed.inject(ModalController);
    internals = component as unknown as typeof internals;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('applies the configured dark color scheme to the header', () => {
    const header = fixture.nativeElement.querySelector('ion-header');
    const closeButton = header.querySelector('ion-button');

    expect(header.classList.contains('photo-editor-header-buttons-dark')).toBe(true);
    expect(header.classList.contains('photo-editor-header-buttons-light')).toBe(false);
    expect(header.style.colorScheme).toBe('dark');
    expect(getComputedStyle(closeButton).getPropertyValue('--color').trim()).toBe(
      'var(--ion-photo-editor-header-button-color-on-dark, #f4f5f8)',
    );
  });

  it('applies the configured light color scheme to regular Ionic buttons', () => {
    componentRef.setInput('toolbarColorScheme', 'light');
    fixture.detectChanges();
    const header = fixture.nativeElement.querySelector('ion-header');
    const closeButton = header.querySelector('ion-button');

    expect(header.classList.contains('photo-editor-header-buttons-dark')).toBe(false);
    expect(header.classList.contains('photo-editor-header-buttons-light')).toBe(true);
    expect(header.style.colorScheme).toBe('light');
    expect(getComputedStyle(closeButton).getPropertyValue('--color').trim()).toBe(
      'var(--ion-photo-editor-header-button-color-on-light, #222428)',
    );
  });

  it('coerces modal primitive inputs and renders the configured delete label', async () => {
    componentRef.setInput('imageUrls', ['first.jpg', 'second.jpg', 'third.jpg']);
    componentRef.setInput('index', '2');
    componentRef.setInput('isCircle', 'true');
    componentRef.setInput('enableDelete', 'true');
    componentRef.setInput('enableFooterSafeArea', 'true');
    componentRef.setInput('labels', { delete: 'Remove photo' });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.index()).toBe(2);
    expect(component.isCircle()).toBe(true);
    expect(component.enableDelete()).toBe(true);
    expect(component.enableFooterSafeArea()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Remove photo');
  });

  it('applies per-image alt text and the localized close-button label', async () => {
    componentRef.setInput('imageUrls', ['same.jpg', 'same.jpg']);
    componentRef.setInput('imageAlt', (_url: string, index: number) => `Uploaded photo ${index + 1}`);
    componentRef.setInput('labels', { close: 'Close viewer' });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(Array.from<HTMLImageElement>(fixture.nativeElement.querySelectorAll('img')).map(({ alt }) => alt)).toEqual([
      'Uploaded photo 1',
      'Uploaded photo 2',
    ]);
    expect(fixture.nativeElement.querySelector('ion-button').getAttribute('aria-label')).toBe('Close viewer');
    expect(fixture.nativeElement.querySelectorAll('swiper-slide')).toHaveLength(2);
  });

  it('dismisses with the active image index and value when removing', () => {
    componentRef.setInput('imageUrls', ['first.jpg', 'second.jpg']);
    fixture.detectChanges();
    internals.swiper()!.nativeElement.swiper = { activeIndex: 1 } as never;
    const dismiss = vi.spyOn(modalCtrl, 'dismiss').mockResolvedValue(true);

    component.remove();

    expect(dismiss).toHaveBeenCalledWith({ action: 'delete', index: 1, value: 'second.jpg' });
  });

  it('does not delete an empty list and clamps an out-of-range active index', () => {
    const dismiss = vi.spyOn(modalCtrl, 'dismiss').mockResolvedValue(true);

    component.remove();
    expect(dismiss).not.toHaveBeenCalled();

    componentRef.setInput('imageUrls', ['first.jpg', 'second.jpg']);
    fixture.detectChanges();
    internals.swiper()!.nativeElement.swiper = { activeIndex: 99 } as never;
    component.remove();

    expect(dismiss).toHaveBeenCalledWith({ action: 'delete', index: 1, value: 'second.jpg' });
  });

  it('dismisses on a downward swipe when the active slide is not zoomed', () => {
    const dismiss = vi.spyOn(modalCtrl, 'dismiss').mockResolvedValue(true);
    const host = fixture.nativeElement;

    host.dispatchEvent(new CustomEvent('touchstart', { detail: [undefined, { clientX: 0, clientY: 0 }] }));
    host.dispatchEvent(new CustomEvent('touchmove', { detail: [undefined, { clientX: 1, clientY: 10 }] }));
    host.dispatchEvent(new CustomEvent('touchend'));

    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('does not dismiss on a downward swipe while the active slide is zoomed', () => {
    componentRef.setInput('imageUrls', ['zoomed.jpg']);
    fixture.detectChanges();
    const activeSlide = fixture.nativeElement.querySelector('swiper-slide');
    activeSlide.classList.add('swiper-slide-active', 'swiper-slide-zoomed');
    const dismiss = vi.spyOn(modalCtrl, 'dismiss').mockResolvedValue(true);
    const host = fixture.nativeElement;

    host.dispatchEvent(new CustomEvent('touchstart', { detail: [undefined, { clientX: 0, clientY: 0 }] }));
    host.dispatchEvent(new CustomEvent('touchmove', { detail: [undefined, { clientX: 1, clientY: 10 }] }));
    host.dispatchEvent(new CustomEvent('touchend'));

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('unsubscribes swipe handling on destroy', () => {
    const unsubscribe = vi.spyOn(internals.watchSwipe$, 'unsubscribe');

    component.ngOnDestroy();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
