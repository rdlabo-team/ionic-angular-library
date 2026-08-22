import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

import { DynamicSizeVirtualScrollService } from './dynamic-size-virtual-scroll.service';
import { testConfig } from '../../../util/test.config';

const createViewportMock = (overrides: Partial<CdkVirtualScrollViewport> = {}): CdkVirtualScrollViewport =>
  ({
    scrollToOffset: vi.fn(),
    measureScrollOffset: vi.fn().mockReturnValue(0),
    getRenderedRange: vi.fn().mockReturnValue({ start: 0, end: 0 }),
    setRenderedContentOffset: vi.fn(),
    setRenderedRange: vi.fn(),
    ...overrides,
  }) as unknown as CdkVirtualScrollViewport;

describe('DynamicSizeVirtualScrollService', () => {
  let service: DynamicSizeVirtualScrollService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    service = TestBed.inject(DynamicSizeVirtualScrollService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('restores a saved scroll offset on init when it is greater than zero', () => {
    const viewport = createViewportMock();

    service.onInit(viewport, 120);

    expect(viewport.scrollToOffset).toHaveBeenCalledWith(120);
  });

  it('does not scroll on init when the saved offset is zero', () => {
    const viewport = createViewportMock();

    service.onInit(viewport, 0);

    expect(viewport.scrollToOffset).not.toHaveBeenCalled();
  });

  it('returns the top scroll offset on destroy', () => {
    const viewport = createViewportMock({
      measureScrollOffset: vi.fn().mockReturnValue(88),
    });

    expect(service.onDestroy(viewport)).toBe(88);
    expect(viewport.measureScrollOffset).toHaveBeenCalledWith('top');
  });

  it('binds temporary items to auto height and fixed items to pixel height', () => {
    const heights = TestBed.runInInjectionContext(() =>
      service.getBindDynamicItemHeight(
        signal([
          { itemSize: 50, source: 'fixed' },
          { itemSize: 80, source: 'temporary' },
        ]),
      ),
    );

    expect(heights()).toEqual(['50px', 'auto']);
  });

  it('allows merge only at the top of the rendered range within mergeScrollY', () => {
    const nearTop = createViewportMock({
      getRenderedRange: vi.fn().mockReturnValue({ start: 0, end: 5 }),
      measureScrollOffset: vi.fn().mockReturnValue(service.mergeScrollY - 1),
    });
    const scrolledDown = createViewportMock({
      getRenderedRange: vi.fn().mockReturnValue({ start: 0, end: 5 }),
      measureScrollOffset: vi.fn().mockReturnValue(service.mergeScrollY),
    });
    const notAtTop = createViewportMock({
      getRenderedRange: vi.fn().mockReturnValue({ start: 2, end: 5 }),
      measureScrollOffset: vi.fn().mockReturnValue(0),
    });

    expect(service.isEnableMerge(nearTop)).toBe(true);
    expect(service.isEnableMerge(scrolledDown)).toBe(false);
    expect(service.isEnableMerge(notAtTop)).toBe(false);
  });

  it('resets viewport geometry when refreshing after a destructive array replacement', () => {
    const viewport = createViewportMock();

    service.refreshViewport(viewport);

    expect(viewport.scrollToOffset).toHaveBeenCalledWith(0);
    expect(viewport.setRenderedContentOffset).toHaveBeenCalledWith(0);
    expect(viewport.setRenderedRange).toHaveBeenCalledWith({ start: 0, end: 0 });
  });

  it('scrolls immediately to the vertical offset when duration is shorter than two frames', async () => {
    const viewport = createViewportMock();

    await service.scrollToPoint(viewport, 25, 75, 31);

    expect(viewport.scrollToOffset).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('scrolls immediately to the horizontal offset for a horizontal viewport', async () => {
    const viewport = createViewportMock({ orientation: 'horizontal' });

    await service.scrollToPoint(viewport, 25, 75, 31);

    expect(viewport.scrollToOffset).toHaveBeenCalledExactlyOnceWith(25);
  });

  it('eases through intermediate offsets and resolves at the requested point', async () => {
    const frames: FrameRequestCallback[] = [];
    const viewport = createViewportMock({
      measureScrollOffset: vi.fn().mockReturnValue(100),
    });
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    const scrolling = service.scrollToPoint(viewport, 60, 200, 100);
    frames.shift()!(0);
    frames.shift()!(50);

    expect(viewport.scrollToOffset).toHaveBeenCalledWith(187);

    frames.shift()!(100);
    await scrolling;

    expect(viewport.scrollToOffset).toHaveBeenCalledWith(200);
    expect(viewport.scrollToOffset).not.toHaveBeenCalledWith(60);
    expect(viewport.measureScrollOffset).toHaveBeenCalledExactlyOnceWith('top');
  });

  it('delegates top scrolling to the smooth point helper', async () => {
    const viewport = createViewportMock();
    const scrollToPoint = vi.spyOn(service, 'scrollToPoint').mockResolvedValue(undefined);

    await service.scrollToTopSmooth(viewport);

    expect(scrollToPoint).toHaveBeenCalledExactlyOnceWith(viewport, 0, 0, 400);
  });
});
