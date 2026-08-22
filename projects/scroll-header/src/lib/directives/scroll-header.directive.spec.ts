import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IonContent, IonHeader, ScrollDetail } from '@ionic/angular';
import { ScrollHeaderDirective } from './scroll-header.directive';
import { testConfig } from '../../../../util/test.config';

@Component({
  template: `
    <header class="native-header">Native Header</header>
    <ion-content rdlaboScrollHeader>
      <ion-header>
        <div>Header Content</div>
      </ion-header>
      <div>Content</div>
    </ion-content>
  `,
  imports: [IonContent, IonHeader, ScrollHeaderDirective],
})
class TestComponent {}

describe('ScrollHeaderDirective', () => {
  let fixture: ComponentFixture<TestComponent>;
  let directive: ScrollHeaderDirective;
  let contentEl: HTMLIonContentElement;
  let nativeHeaderEl: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(TestComponent);
    fixture.detectChanges();

    const directiveEl = fixture.debugElement.query((el) => el.nativeElement.tagName.toLowerCase() === 'ion-content');
    directive = directiveEl.injector.get(ScrollHeaderDirective);
    contentEl = directiveEl.nativeElement;
    nativeHeaderEl = fixture.nativeElement.querySelector('.native-header');

    const header = contentEl.querySelector('ion-header');
    Object.defineProperty(header, 'clientHeight', { configurable: true, value: 60 });
    await vi.waitFor(() => expect(contentEl.scrollEvents).toBe(true));
  });

  afterEach(() => vi.restoreAllMocks());

  const scroll = (scrollTop: number) => {
    directive.onWindowScroll(new CustomEvent('ionScroll', { detail: { scrollTop } }) as CustomEvent<ScrollDetail>);
  };

  it('should create an instance', () => {
    expect(directive).toBeTruthy();
  });

  it('enables Ionic scroll events and discovers the content header', () => {
    expect(directive.scrollHeader()).toBeTruthy();
    expect(contentEl.scrollEvents).toBe(true);
  });

  it('hides the content and native headers after scrolling down past the header', () => {
    vi.spyOn(performance, 'now').mockReturnValue(20);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    scroll(100);

    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(true);
    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(true);
    expect(contentEl.classList.contains('scroll-header-animated')).toBe(true);
    expect(nativeHeaderEl.classList.contains('scroll-header-hidden')).toBe(true);
  });

  it('reveals both headers and keeps the content sticky when scrolling up below the header', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(20).mockReturnValueOnce(40);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);

    scroll(120);
    scroll(80);

    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(false);
    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(true);
    expect(contentEl.classList.contains('scroll-header-animated')).toBe(true);
    expect(nativeHeaderEl.classList.contains('scroll-header-hidden')).toBe(false);
  });

  it('clears transient classes when returning to the top', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(20).mockReturnValueOnce(40);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    scroll(100);
    scroll(0);

    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(false);
    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(false);
    expect(contentEl.classList.contains('scroll-header-animated')).toBe(false);
    expect(nativeHeaderEl.classList.contains('scroll-header-hidden')).toBe(false);
  });

  it('keeps a fixed header sticky without hiding it', () => {
    contentEl.classList.add('fixed');
    vi.spyOn(performance, 'now').mockReturnValue(20);

    scroll(100);

    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(true);
    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(false);
  });

  it('ignores scroll updates inside the throttle window', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10);

    scroll(100);

    expect(contentEl.classList.contains('scroll-header-sticky')).toBe(false);
    expect(contentEl.classList.contains('scroll-header-hidden')).toBe(false);
  });
});
