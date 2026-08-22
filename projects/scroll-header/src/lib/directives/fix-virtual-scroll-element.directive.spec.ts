import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf } from '@angular/cdk/scrolling';
import { FixVirtualScrollElementDirective } from './fix-virtual-scroll-element.directive';
import { testConfig } from '../../../../util/test.config';

@Component({
  template: `
    <cdk-virtual-scroll-viewport itemSize="50" style="height: 200px" rdlaboFixVirtualScrollElement>
      <div *cdkVirtualFor="let item of items">{{ item }}</div>
    </cdk-virtual-scroll-viewport>
  `,
  imports: [CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, FixVirtualScrollElementDirective, CdkVirtualForOf],
})
class TestComponent {
  items = [1, 2, 3, 4, 5];
}

describe('FixVirtualScrollElementDirective', () => {
  let fixture: ComponentFixture<TestComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(TestComponent);
    fixture.detectChanges();
  });

  it('should create the directive instance', () => {
    const directiveEl = fixture.debugElement.query((el) => el.nativeElement.tagName.toLowerCase() === 'cdk-virtual-scroll-viewport');

    const directiveInstance = directiveEl.injector.get(FixVirtualScrollElementDirective);
    expect(directiveInstance).toBeTruthy();
  });

  it('moves the virtual scroll spacer before the content wrapper', () => {
    const viewport = fixture.nativeElement.querySelector('cdk-virtual-scroll-viewport');
    const children = Array.from(viewport.children) as HTMLElement[];

    expect(children[0].classList.contains('cdk-virtual-scroll-spacer')).toBe(true);
    expect(children.at(-1)?.classList.contains('cdk-virtual-scroll-content-wrapper')).toBe(true);
  });
});
