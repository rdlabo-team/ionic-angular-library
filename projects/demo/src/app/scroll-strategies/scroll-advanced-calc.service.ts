import { Injectable, signal } from '@angular/core';
import { DynamicSizeCache, ScrollAdvancedItem } from './scroll-strategies.type';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { itemDynamicSize } from 'scroll-strategies';

@Injectable({
  providedIn: 'root',
})
export class ScrollAdvancedCalcService {
  readonly cacheCalcDynamic = signal<DynamicSizeCache[]>([]);
  readonly beforeCacheCalcDynamicSize = signal<number>(0);

  changeItemsToDynamicItemSize(
    items: ScrollAdvancedItem[],
    dynamicSizeCache: DynamicSizeCache[],
    virtualScroll: CdkVirtualScrollViewport | undefined,
  ): itemDynamicSize[] {
    if (virtualScroll === undefined) {
      return [];
    }
    return (
      items?.map((item, index) => {
        const cacheSize = dynamicSizeCache.find((cache) => cache.trackId === item.trackId)?.itemSize;

        /**
         * 150 is approximate item size.
         * This is important for the accuracy of the initial display.
         */
        const itemSize = cacheSize || 150;

        return {
          itemSize: Math.ceil(itemSize),
          trackId: item.trackId,
          source: cacheSize !== undefined ? 'cache' : 'temporary',
        };
      }) || []
    );
  }
}
