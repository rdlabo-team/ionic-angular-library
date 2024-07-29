import { Component, computed, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { CdkDynamicSizeVirtualScroll, itemDynamicSize } from 'scroll-strategies';
import { FixVirtualScrollElementDirective } from 'scroll-header';

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
  ],
})
export class ScrollSimplePage implements OnInit {
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