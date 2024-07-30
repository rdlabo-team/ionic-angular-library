import { Component, effect, ElementRef, inject, input, OnInit, output } from '@angular/core';
import { ScrollAdvancedItem } from '../../scroll-strategies.type';
import { IonAvatar, IonButton, IonButtons, IonIcon, IonImg, IonItem, IonLabel } from '@ionic/angular/standalone';
import { ScrollAdvancedCalcService } from '../../scroll-advanced-calc.service';
import { closeOutline } from 'ionicons/icons';

@Component({
  selector: 'app-scroll-advanced-item',
  templateUrl: './scroll-advanced-item.component.html',
  styleUrls: ['./scroll-advanced-item.component.scss'],
  standalone: true,
  imports: [IonItem, IonAvatar, IonImg, IonLabel, IonButtons, IonButton, IonIcon],
})
export class ScrollAdvancedItemComponent implements OnInit {
  item = input.required<ScrollAdvancedItem>();
  delete = output<string>();
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

  deleteItem(trackId: string) {
    this.delete.emit(trackId);
  }
}
