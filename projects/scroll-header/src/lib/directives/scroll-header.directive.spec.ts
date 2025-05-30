import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IonContent, IonHeader } from '@ionic/angular/standalone';
import { ScrollHeaderDirective } from './scroll-header.directive';
import { testConfig } from '../../../../util/test.config';

@Component({
  template: `
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

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(TestComponent);
    fixture.detectChanges();

    const directiveEl = fixture.debugElement.query((el) => el.nativeElement.tagName.toLowerCase() === 'ion-content');
    directive = directiveEl.injector.get(ScrollHeaderDirective);
  });

  it('should create an instance', () => {
    expect(directive).toBeTruthy();
  });

  it('should initialize with correct properties', () => {
    expect(directive.scrollHeader()).toBeTruthy();
  });

  it('should handle scroll events', () => {
    const contentEl = fixture.debugElement.query((el) => el.nativeElement.tagName.toLowerCase() === 'ion-content').nativeElement;

    // スクロールイベントをシミュレート
    const scrollEvent = new CustomEvent('ionScroll', {
      detail: {
        scrollTop: 100,
        scrollLeft: 0,
        type: 'scroll',
      },
    });
    contentEl.dispatchEvent(scrollEvent);

    // スクロール後のクラスを確認
    expect(contentEl.classList.contains('scroll-header-sticky')).toBeTruthy();
  });
});
