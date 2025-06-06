import { ChangeDetectionStrategy, Component, computed, OnInit, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ViewDidEnter,
  ViewDidLeave,
} from '@ionic/angular/standalone';
import { CdkDynamicSizeVirtualScroll, itemDynamicSize } from '@rdlabo/ngx-cdk-scroll-strategies';
import { CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { FixVirtualScrollElementDirective } from '@rdlabo/ionic-angular-scroll-header';
import { Subscription } from 'rxjs';

type Item = itemDynamicSize & {
  trackId: number;
};

@Component({
  selector: 'app-scroll-reverse',
  templateUrl: './scroll-reverse.page.html',
  styleUrls: ['./scroll-reverse.page.scss'],
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
    IonSpinner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScrollReversePage implements OnInit, ViewDidEnter, ViewDidLeave {
  readonly virtualScroll = viewChild(CdkVirtualScrollViewport);
  readonly #enterSubscription$: Subscription[] = [];
  readonly isReady = signal(false);
  readonly isLoading = signal(false);
  readonly items = signal<Item[]>([]);
  readonly dynamicSize = computed<itemDynamicSize[]>(() => {
    return this.items().map((item) => ({ trackId: item.trackId, itemSize: item.itemSize }));
  });

  ngOnInit() {
    this.items.set(this.#createItems(100));
  }

  ionViewDidEnter() {
    this.#enterSubscription$.push(
      this.virtualScroll()!.scrolledIndexChange.subscribe(async (index) => {
        /**
         * For infinite scroll. If renderRange.end is the last index of the rendered items, then add new items.
         */
        if (this.isReady() && !this.isLoading() && this.virtualScroll()!.getRenderedRange().end === this.virtualScroll()!.getDataLength()) {
          this.isLoading.set(true);
          await new Promise((resolve) => setTimeout(resolve, 500));
          this.items.update((items) => {
            // You must create new array.
            return [...items, ...this.#createItems(100)];
          });
          this.isLoading.set(false);
        }
      }),
    );
    this.isReady.set(true);
  }

  async ionViewDidLeave() {
    this.#enterSubscription$.forEach((sub) => sub.unsubscribe());
  }

  #createItems(length: number): Item[] {
    return Array.from({ length }).map((_, index) => {
      return {
        trackId: index,
        itemSize: Math.floor(Math.random() * (80 - 20) + 20),
      };
    });
  }

  trackByFn = (_: number, item: Item) => item.trackId;
}
