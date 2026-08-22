import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { CdkDynamicSizeVirtualScroll, _dynamicSizeVirtualScrollStrategyFactory } from './dynamic-size-virtual-scroll-strategy';
import { itemDynamicSize } from './dynamic-size-virtual-scroll.util';
import { testConfig } from '../../../util/test.config';

@Component({
  template: `
    <cdk-virtual-scroll-viewport
      [itemDynamicSizes]="sizes()"
      [minBufferPx]="minBufferPx()"
      [maxBufferPx]="maxBufferPx()"
      [isReverse]="isReverse()"
      style="height: 200px"
    ></cdk-virtual-scroll-viewport>
  `,
  imports: [CdkVirtualScrollViewport, CdkDynamicSizeVirtualScroll],
})
class HostComponent {
  readonly sizes = signal<itemDynamicSize[]>([{ itemSize: 40 }, { itemSize: 60 }]);
  readonly minBufferPx = signal<number | string>(10);
  readonly maxBufferPx = signal<number | string>(30);
  readonly isReverse = signal(false);
}

describe('CdkDynamicSizeVirtualScroll', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const getDirective = (): CdkDynamicSizeVirtualScroll =>
    fixture.debugElement
      .query((element) => element.nativeElement.tagName.toLowerCase() === 'cdk-virtual-scroll-viewport')
      .injector.get(CdkDynamicSizeVirtualScroll);

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('exposes the directive scroll offset from the installed strategy', () => {
    const directive = getDirective();
    directive._scrollStrategy.measureScrollOffset = 42;

    expect(directive.scrollOffset).toBe(42);
  });

  it('toggles the reverse-scroll class when isReverse changes', () => {
    const viewport = fixture.nativeElement.querySelector('cdk-virtual-scroll-viewport') as HTMLElement;

    expect(viewport.classList.contains('reverse-scroll')).toBe(false);

    host.isReverse.set(true);
    fixture.detectChanges();

    expect(viewport.classList.contains('reverse-scroll')).toBe(true);

    host.isReverse.set(false);
    fixture.detectChanges();

    expect(viewport.classList.contains('reverse-scroll')).toBe(false);
  });

  it('updates the strategy when measured item sizes change', () => {
    const directive = getDirective();
    const updateSpy = vi.spyOn(directive._scrollStrategy, 'updateItemAndBufferSize');
    const sizes = [{ itemSize: 40 }, { itemSize: 60 }, { itemSize: 80 }];

    host.sizes.set(sizes);
    fixture.detectChanges();

    expect(updateSpy).toHaveBeenLastCalledWith(sizes, 10, 30, false);
  });

  it('coerces numeric string buffer inputs before updating the strategy', () => {
    const directive = getDirective();
    const updateSpy = vi.spyOn(directive._scrollStrategy, 'updateItemAndBufferSize');

    host.minBufferPx.set('15');
    host.maxBufferPx.set('45');
    fixture.detectChanges();

    expect(updateSpy).toHaveBeenLastCalledWith(host.sizes(), 15, 45, false);
  });

  it('rejects invalid measured sizes propagated through the directive input', () => {
    host.sizes.set([{ itemSize: 0 }]);

    expect(() => fixture.detectChanges()).toThrow(/index 0/);
  });

  it('provides the directive strategy through the factory helper', () => {
    const directive = getDirective();

    expect(_dynamicSizeVirtualScrollStrategyFactory(directive)).toBe(directive._scrollStrategy);
  });
});
