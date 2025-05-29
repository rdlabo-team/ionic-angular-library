import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  inject,
  Input,
  OnDestroy,
  OnInit,
  input,
  viewChild,
  signal,
  effect,
  ChangeDetectionStrategy,
} from '@angular/core';
import { IonicSlides, ModalController } from '@ionic/angular/standalone';
import { Navigation, Zoom } from 'swiper/modules';
import { fromEvent, Subscription, throttleTime, withLatestFrom, zipWith } from 'rxjs';
import { SwiperContainer } from 'swiper/element';
import { ionComponents } from '../ion-components';
import { HelperService } from '../service/helper.service';
import { IDictionaryForViewer, IPhotoViewerDismiss } from '../types';
import { register } from 'swiper/element/bundle';
import { dictionaryForViewer } from '../dictionaries';
import { BooleanInput, coerceBooleanProperty, coerceNumberProperty, NumberInput } from '@angular/cdk/coercion';

@Component({
  selector: 'app-photo-image',
  templateUrl: './photo-viewer.page.html',
  styleUrls: ['./core.scss', './photo-viewer.page.scss'],
  imports: [...ionComponents],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  providers: [HelperService],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoViewerPage implements OnInit, OnDestroy {
  readonly imageUrls = input.required<string[]>();
  readonly index = input<number, NumberInput>(0, {
    transform: coerceNumberProperty,
  });
  readonly isCircle = input<boolean, BooleanInput>(false, {
    transform: coerceBooleanProperty,
  });
  readonly enableDelete = input<boolean, BooleanInput>(false, {
    transform: coerceBooleanProperty,
  });
  readonly enableFooterSafeArea = input<boolean, BooleanInput>(false, {
    transform: coerceBooleanProperty,
  });
  readonly labels = input<Partial<IDictionaryForViewer>>();
  readonly setLabels = effect(() => {
    if (this.labels()) {
      this.dictionary.update((value) => ({ ...value, ...this.labels() }));
    }
  });

  readonly swiper = viewChild.required<ElementRef<SwiperContainer>>('swiper');
  protected readonly dictionary = signal<IDictionaryForViewer>(dictionaryForViewer());

  readonly watchSwipe$ = new Subscription();
  readonly modalCtrl = inject(ModalController);
  private readonly el = inject(ElementRef);
  private readonly service = inject(HelperService);

  constructor() {
    register();
    this.service.initializeViewerIcons();
  }

  async ngOnInit() {
    this.service.waitToFindDom(this.el.nativeElement, 'swiper-container').then(() => {
      const index = this.index();
      const swiper = this.swiper();
      Object.assign(swiper.nativeElement, {
        modules: [Navigation, Zoom, IonicSlides],
        initialSlide: index,
        slidesPerView: 1,
        pagination: {
          enabled: true,
          clickable: true,
        },
        zoom: true,
      });
      swiper.nativeElement.initialize();
      swiper.nativeElement.swiper.zoom.enable();

      swiper.nativeElement.swiper.activeIndex = index;
      swiper.nativeElement.swiper.update();
    });

    this.watchSwipe$.add(
      fromEvent<TouchEvent>(this.el.nativeElement, 'touchstart')
        .pipe(
          zipWith(
            fromEvent<TouchEvent>(this.el.nativeElement, 'touchend').pipe(
              withLatestFrom(fromEvent<TouchEvent>(this.el.nativeElement, 'touchmove')),
            ),
          ),
          throttleTime(1),
        )
        .subscribe(([touchstart, [_, touchmove]]) => {
          const touchstartClientX = touchstart.touches ? touchstart.touches[0].clientX : (touchstart as any).detail[1].clientX;
          const touchmoveClientX = touchmove.touches ? touchmove.touches[0].clientX : (touchmove as any).detail[1].clientX;

          const touchstartClientY = touchstart.touches ? touchstart.touches[0].clientY : (touchstart as any).detail[1].clientY;
          const touchmoveClientY = touchmove.touches ? touchmove.touches[0].clientY : (touchmove as any).detail[1].clientY;

          const xDiff = touchstartClientX - touchmoveClientX;
          const yDiff = touchstartClientY - touchmoveClientY;

          const slides = (this.swiper() as any).nativeElement.querySelectorAll('swiper-slide') as HTMLElement[];
          const isZoomed = Array.from(slides).find((slide: HTMLElement) => {
            return ['swiper-slide-zoomed', 'swiper-slide-active'].every((c) => slide.classList.contains(c));
          });

          const threshold = touchmove.touches ? -50 : -5;

          if (!isZoomed && Math.abs(xDiff) < Math.abs(threshold) && yDiff < threshold && touchstart.timeStamp <= touchmove.timeStamp) {
            this.watchSwipe$.unsubscribe();
            this.modalCtrl.dismiss();
          }
        }),
    );
  }

  ngOnDestroy() {
    this.watchSwipe$.unsubscribe();
  }

  remove() {
    this.modalCtrl.dismiss({
      delete: {
        index: this.swiper().nativeElement.swiper.activeIndex,
        value: this.imageUrls()[this.swiper().nativeElement.swiper.activeIndex],
      },
    } as IPhotoViewerDismiss);
  }
}
