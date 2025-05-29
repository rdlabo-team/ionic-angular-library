import { ChangeDetectionStrategy, Component, effect, ElementRef, inject, input, OnInit, output } from '@angular/core';
import { ScrollAdvancedItem } from '../../scroll-strategies.type';
import { IonAvatar, IonButton, IonButtons, IonIcon, IonImg, IonItem, IonLabel } from '@ionic/angular/standalone';
import { ScrollAdvancedCalcService } from '../../scroll-advanced-calc.service';

@Component({
  selector: 'app-scroll-advanced-item',
  templateUrl: './scroll-advanced-item.component.html',
  styleUrls: ['./scroll-advanced-item.component.scss'],
  imports: [IonItem, IonAvatar, IonImg, IonLabel, IonButtons, IonButton, IonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScrollAdvancedItemComponents {
  readonly #el = inject(ElementRef);
  readonly #calcService = inject(ScrollAdvancedCalcService);

  readonly item = input.required<ScrollAdvancedItem>();
  readonly delete = output<string>();

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

  deleteItem(trackId: string) {
    this.delete.emit(trackId);
  }
}
