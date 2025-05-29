import { Component, computed, inject, OnInit, signal, viewChild, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonFab,
  IonFabButton,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonList,
  IonRefresher,
  IonRefresherContent,
  IonTitle,
  IonToolbar,
  ViewDidEnter,
  ViewWillLeave,
} from '@ionic/angular/standalone';
import { InfiniteScrollCustomEvent, RefresherCustomEvent } from '@ionic/angular';
import { ScrollAdvancedItem } from '../../scroll-strategies.type';
import { CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { CdkDynamicSizeVirtualScroll, DynamicSizeVirtualScrollService, itemDynamicSize } from '@rdlabo/ngx-cdk-scroll-strategies';
// import {
//   CdkDynamicSizeVirtualScroll,
//   DynamicSizeVirtualScrollService,
//   itemDynamicSize
// } from '../../../../../../scroll-strategies/src/public-api';
import { FixVirtualScrollElementDirective } from '@rdlabo/ionic-angular-scroll-header';
import { ScrollAdvancedItemComponent } from '../../components/scroll-advanced-item/scroll-advanced-item.component';
import { ScrollAdvancedCalcService } from '../../scroll-advanced-calc.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-scroll-advanced',
  templateUrl: './scroll-advanced.page.html',
  styleUrls: ['./scroll-advanced.page.scss'],
  imports: [
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    CommonModule,
    FormsModule,
    IonBackButton,
    IonButtons,
    IonButton,
    IonIcon,
    CdkDynamicSizeVirtualScroll,
    CdkVirtualForOf,
    CdkVirtualScrollViewport,
    FixVirtualScrollElementDirective,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonList,
    ScrollAdvancedItemComponent,
    IonFab,
    IonFabButton,
    IonRefresher,
    IonRefresherContent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScrollAdvancedPage implements OnInit, ViewDidEnter, ViewWillLeave {
  readonly virtualScroll = viewChild(CdkVirtualScrollViewport);
  readonly #enterSubscription$: Subscription[] = [];

  /** This is included @rdlabo/ngx-cdk-scroll-strategies **/
  readonly #scroll = inject(DynamicSizeVirtualScrollService);
  readonly #calcService = inject(ScrollAdvancedCalcService);

  #latestScrollOffset = 0;
  readonly items = signal<ScrollAdvancedItem[]>([]);
  readonly dynamicSize = computed<itemDynamicSize[]>(() => {
    return this.#calcService.changeItemsToDynamicItemSize(this.items(), this.#calcService.cacheCalcDynamic(), this.virtualScroll());
  });

  constructor() {}

  ngOnInit() {
    this.items.set(this.#createItems(100));
  }

  ionViewDidEnter() {
    /*
     * iOS smooth scroll can scroll after transition end.
     * In this case, sometimes Virtual Scroll is white screen.
     * Scroll amount restoration prevents this.
     */
    this.#scroll.onInit(this.virtualScroll()!, this.#latestScrollOffset);

    this.#enterSubscription$.push(
      this.virtualScroll()!.scrolledIndexChange.subscribe(() => {
        /**
         * If scroll index is changed and number of calc items, update cacheCalcDynamic for notify to computed.
         */
        if (this.#calcService.beforeCacheCalcDynamicSize() !== this.#calcService.cacheCalcDynamic().length) {
          this.#calcService.cacheCalcDynamic.update((cache) => [...cache]);
          this.#calcService.beforeCacheCalcDynamicSize.set(this.#calcService.cacheCalcDynamic().length);
        }
      }),
    );
  }

  ionViewWillLeave() {
    /**
     * Save scroll amount for next view enter.
     */
    this.#latestScrollOffset = this.#scroll.onDestroy(this.virtualScroll()!);
    this.#enterSubscription$.forEach((subscription) => subscription.unsubscribe());
  }

  deleteItem(trackId: string) {
    this.items.update((items) => {
      return items.filter((item) => item.trackId !== trackId);
    });
  }

  async toTop() {
    await this.#scroll.scrollToTopSmooth(this.virtualScroll()!);
  }

  async refreshAllItems(event: RefresherCustomEvent) {
    this.items.set(this.#createItems(100));
    await event.target.complete();

    /**
     * Refresh viewport after destroy items.
     */
    this.#scroll.refreshViewport(this.virtualScroll()!);
  }

  async loadInfinite(event: InfiniteScrollCustomEvent) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.items.update((items) => {
      return [...items, ...this.#createItems(100)];
    });
    await event.target.complete();
  }

  /**
   * Create items for demo. This is not a part of the library.
   */
  readonly page = signal<number>(0);
  #createItems(length: number): ScrollAdvancedItem[] {
    this.page.update((page) => page + 1);
    return Array.from({ length }).map((_, index) => {
      const nameLength = Math.floor(Math.random() * (10 - 5)) + 5;
      const descriptionLength = Math.floor(Math.random() * (400 - 20)) + 20;
      return {
        trackId: this.page() + '-' + index,
        name: Array.from({ length: 100 })
          .map(() => Math.random().toString(36))
          .join()
          .slice(-1 * nameLength),
        description: Array.from({ length: 100 })
          .map(() => Math.random().toString(36))
          .join()
          .slice(-1 * descriptionLength),
        photo: `https://picsum.photos/200?random=${index}`,
      };
    });
  }
  trackByFn = (_: number, item: ScrollAdvancedItem) => item.trackId;
}
