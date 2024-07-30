import { Component, computed, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { CdkDynamicSizeVirtualScroll, itemDynamicSize } from '@rdlabo/ngx-cdk-scroll-strategies';
import { FixVirtualScrollElementDirective } from '@rdlabo/ionic-angular-scroll-header';
import { InfiniteScrollCustomEvent } from '@ionic/angular';

type Item = itemDynamicSize & {
  trackId: number;
};

@Component({
  selector: 'app-scroll-simple',
  templateUrl: './scroll-simple.page.html',
  styleUrls: ['./scroll-simple.page.scss'],
  standalone: true,
  imports: [
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    CommonModule,
    FormsModule,
    CdkVirtualScrollViewport,
    CdkVirtualForOf,
    CdkDynamicSizeVirtualScroll,
    FixVirtualScrollElementDirective,
    IonButton,
    IonButtons,
    IonIcon,
    IonBackButton,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
  ],
})
export class ScrollSimplePage implements OnInit {
  readonly items = signal<Item[]>([]);
  readonly dynamicSize = computed<itemDynamicSize[]>(() => {
    return this.items().map((item) => ({ trackId: item.trackId, itemSize: item.itemSize }));
  });

  constructor() {}

  ngOnInit() {
    this.items.set(this.#createItems(200));
  }

  async loadInfinite(event: InfiniteScrollCustomEvent) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.items.update((items) => {
      // You must create new array.
      return [...items, ...this.#createItems(200)];
    });
    await event.target.complete();
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
