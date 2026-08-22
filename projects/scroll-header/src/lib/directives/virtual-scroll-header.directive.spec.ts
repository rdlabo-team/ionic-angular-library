import { Component, viewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IonContent, IonHeader, IonRefresher } from '@ionic/angular';
import { VirtualScrollHeaderDirective } from './virtual-scroll-header.directive';
import { CdkFixedSizeVirtualScroll, CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { testConfig } from '../../../../util/test.config';

@Component({
  template: `
    <header class="native-header">Native Header</header>
    <ion-content rdlaboVirtualScrollHeader>
      <ion-header>
        <div>Header Content</div>
      </ion-header>
      <ion-refresher></ion-refresher>
      <cdk-virtual-scroll-viewport minBufferPx="900" maxBufferPx="1350" [itemSize]="44" class="ion-content-scroll-host">
        <div *cdkVirtualFor="let item of items">
          {{ item }}
        </div>
      </cdk-virtual-scroll-viewport>
    </ion-content>
  `,
  imports: [
    IonContent,
    IonHeader,
    IonRefresher,
    VirtualScrollHeaderDirective,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
  ],
})
class TestComponent {
  viewport = viewChild(CdkVirtualScrollViewport);
  items = Array.from({ length: 100 }, (_, i) => `Item ${i}`);
}

describe('VirtualScrollHeaderDirective', () => {
  let fixture: ComponentFixture<TestComponent>;
  let directive: VirtualScrollHeaderDirective;
  let contentEl: HTMLIonContentElement;
  let nativeHeaderEl: HTMLElement;
  let viewport: CdkVirtualScrollViewport;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(TestComponent);
    fixture.detectChanges();
    viewport = fixture.componentInstance.viewport()!;

    const directiveEl = fixture.debugElement.query((el) => el.nativeElement.tagName.toLowerCase() === 'ion-content');
    directive = directiveEl.injector.get(VirtualScrollHeaderDirective);
    contentEl = directiveEl.nativeElement;
    nativeHeaderEl = fixture.nativeElement.querySelector('.native-header');

    const header = contentEl.querySelector('ion-header');
    Object.defineProperty(header, 'clientHeight', { configurable: true, value: 60 });
    await vi.waitFor(() => expect(contentEl.classList.contains('scroll-header-animated')).toBe(true));
  });

  afterEach(() => vi.restoreAllMocks());

  it('should create an instance', () => {
    expect(directive).toBeTruthy();
  });

  it('discovers its children and starts in the animated state', () => {
    expect(directive.virtualScroll()).toBe(viewport);
    expect(directive.scrollHeader()).toBeTruthy();
    expect(contentEl.classList.contains('scroll-header-animated')).toBe(true);
  });

  it('applies viewport and refresher offsets when measuring the header', () => {
    vi.spyOn(performance, 'now').mockReturnValue(20);

    directive.onWindowScroll(100);

    expect(viewport.elementRef.nativeElement.style.marginTop).toBe('-60px');
    expect(viewport.elementRef.nativeElement.style.paddingTop).toBe('60px');
    expect(contentEl.querySelector('ion-refresher')?.style.marginTop).toBe('60px');
  });

  it('hides the content and native headers after scrolling down past the threshold', () => {
    vi.spyOn(performance, 'now').mockReturnValue(20);

    directive.onWindowScroll(100);

    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(true);
    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(true);
    expect(nativeHeaderEl.classList.contains('scroll-header-hidden')).toBe(true);
  });

  it('reveals both headers while scrolling up and keeps the content sticky', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(20).mockReturnValueOnce(40);

    directive.onWindowScroll(100);
    directive.onWindowScroll(60);

    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(false);
    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(true);
    expect(nativeHeaderEl.classList.contains('scroll-header-hidden')).toBe(false);
  });

  it('keeps a fixed header sticky without hiding it', () => {
    contentEl.classList.add('fixed');
    vi.spyOn(performance, 'now').mockReturnValue(20);

    directive.onWindowScroll(100);

    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(true);
    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(false);
  });

  it('ignores updates inside the throttle window', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10);

    directive.onWindowScroll(100);

    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(false);
    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(false);
  });

  it('forwards viewport scroll events until destroyed', () => {
    const onWindowScroll = vi.spyOn(directive, 'onWindowScroll');

    viewport.elementRef.nativeElement.dispatchEvent(new Event('scroll'));
    expect(onWindowScroll).toHaveBeenCalledOnce();

    onWindowScroll.mockClear();
    directive.ngOnDestroy();
    viewport.elementRef.nativeElement.dispatchEvent(new Event('scroll'));

    expect(onWindowScroll).not.toHaveBeenCalled();
  });
});
