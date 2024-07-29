import { Component, computed, effect, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

import { CdkDynamicSizeVirtualScroll, itemDynamicSize } from '@rdlabo/ngx-cdk-scroll-strategies';
// import { CdkDynamicSizeVirtualScroll, itemDynamicSize } from '../../../../scroll-strategies/src/lib/dynamic-size-virtual-scroll-strategy';
import { FixVirtualScrollElementDirective } from '@rdlabo/ionic-angular-scroll-header';

type Item = itemDynamicSize & {
  trackId: number;
};

@Component({
  selector: 'app-scroll-strategies',
  templateUrl: './scroll-strategies.page.html',
  styleUrls: ['./scroll-strategies.page.scss'],
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
  ],
})
export class ScrollStrategiesPage implements OnInit {
  readonly min = 20;
  readonly max = 80;

  // Use signals for using computed.
  readonly items = signal<Item[]>([]);
  readonly dynamicSize = computed<itemDynamicSize[]>(() => {
    return this.items().map((item) => ({ trackId: item.trackId, itemSize: item.itemSize }));
  });

  constructor() {}

  ngOnInit() {
    this.items.set(
      Array.from({ length: 10000 }).map((_, index) => {
        return {
          trackId: index,
          itemSize: Math.floor(Math.random() * (this.max - this.min) + this.min),
        };
      }),
    );
  }

  trackByFn = (_: number, item: Item) => item.trackId;
}
