import { Component, ElementRef, viewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IonContent, IonHeader } from '@ionic/angular/standalone';
import { VirtualScrollHeaderDirective } from './virtual-scroll-header.directive';
import { CdkFixedSizeVirtualScroll, CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { testConfig } from '../../../../util/test.config';
import { Signal } from '@angular/core';
import { waitFindDom } from '../util';

@Component({
  template: `
    <ion-content rdlaboVirtualScrollHeader>
      <ion-header>
        <div>Header Content</div>
      </ion-header>
      <cdk-virtual-scroll-viewport minBufferPx="900" maxBufferPx="1350" [itemSize]="44" class="ion-content-scroll-host">
        <div *cdkVirtualFor="let item of items">
          {{ item }}
        </div>
      </cdk-virtual-scroll-viewport>
    </ion-content>
  `,
  imports: [IonContent, IonHeader, VirtualScrollHeaderDirective, CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf],
})
class TestComponent {
  viewport = viewChild(CdkVirtualScrollViewport);
  items = Array.from({ length: 100 }, (_, i) => `Item ${i}`);
}

describe('VirtualScrollHeaderDirective', () => {
  let fixture: ComponentFixture<TestComponent>;
  let directive: VirtualScrollHeaderDirective;
  let viewport: Signal<CdkVirtualScrollViewport>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(TestComponent);
    if (fixture.componentInstance.viewport() === undefined) {
      throw 'viewport is undefined';
    }
    viewport = fixture.componentInstance.viewport as Signal<CdkVirtualScrollViewport>;
    fixture.detectChanges();

    const directiveEl = fixture.debugElement.query((el) => el.nativeElement.tagName.toLowerCase() === 'ion-content');
    directive = directiveEl.injector.get(VirtualScrollHeaderDirective);
  });

  it('should create an instance', () => {
    expect(directive).toBeTruthy();
  });

  it('should initialize with correct properties', () => {
    expect(directive.virtualScroll()).toBeTruthy();
    expect(directive.scrollHeader()).toBeTruthy();
  });

  it('should add class scroll-header-animated', async () => {
    const contentEl = fixture.debugElement.query((el) => el.nativeElement.tagName.toLowerCase() === 'ion-content').nativeElement;
    await waitFindDom(contentEl, 'ion-header');
    expect(contentEl.classList.contains('scroll-header-animated')).toBeTruthy();
  });
});
