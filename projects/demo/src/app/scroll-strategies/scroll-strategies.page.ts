import { Component, computed, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { CdkDynamicSizeVirtualScroll } from '@rdlabo/scroll-strategies';

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
  ],
})
export class ScrollStrategiesPage implements OnInit {
  items = signal<number[]>([]);
  dynamicSize = computed(() => {
    return this.items().map((itemSize, i) => ({ trackId: i, itemSize }));
  });

  readonly min = 20;
  readonly max = 80;
  constructor() {}

  ngOnInit() {
    this.items.set(Array.from({ length: 10000 }).map((_, i) => Math.random() * (this.max - this.min) + this.min));
  }

  trackByFn = (index: number, item: number) => item;
}
