import { Component, effect, ElementRef, inject, input, OnInit } from '@angular/core';
import { ScrollAdvancedItem } from '../../scroll-strategies.type';
import { IonAvatar, IonImg, IonItem, IonLabel } from '@ionic/angular/standalone';
import { ScrollAdvancedCalcService } from '../../scroll-advanced-calc.service';

@Component({
  selector: 'app-scroll-advanced-item',
  templateUrl: './scroll-advanced-item.component.html',
  styleUrls: ['./scroll-advanced-item.component.scss'],
  standalone: true,
  imports: [IonItem, IonAvatar, IonImg, IonLabel],
})
export class ScrollAdvancedItemComponent implements OnInit {
  item = input<ScrollAdvancedItem>();
  #el = inject(ElementRef);
  #calcService = inject(ScrollAdvancedCalcService);

  constructor() {
    effect(() =>
      (async (item: ScrollAdvancedItem | undefined) => {
        if (item === undefined) {
          return;
        }
        // Wait for rendering
        await new Promise((resolve) => requestAnimationFrame(resolve));
        this.#calcService.cacheCalcDynamic.update((cache) => {
          if (!cache.some((c) => c.trackId === item.trackId)) {
            cache.push({
              trackId: item.trackId,
              itemSize: this.#el.nativeElement.getBoundingClientRect().height,
            });
          }
          // Update, but not notify to computed
          return cache;
        });
      })(this.item()),
    );
  }

  ngOnInit() {}
}
