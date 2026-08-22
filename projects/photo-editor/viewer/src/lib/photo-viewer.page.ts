import {
  ChangeDetectionStrategy,
  Component,
  computed,
  CUSTOM_ELEMENTS_SCHEMA,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  OnInit,
  viewChild,
} from '@angular/core';
import { IonicSlides, ModalController } from '@ionic/angular';
import { Navigation, Zoom } from 'swiper/modules';
import { fromEvent, Subscription, throttleTime, withLatestFrom, zipWith } from 'rxjs';
import { SwiperContainer } from 'swiper/element';
import { PhotoToolbarColorScheme, PhotoViewerLabels, PhotoViewerResult } from '@rdlabo/ionic-angular-photo-editor';
import { register } from 'swiper/element/bundle';
import { BooleanInput, coerceBooleanProperty, coerceNumberProperty, NumberInput } from '@angular/cdk/coercion';
import { dictionaryForViewer, initializeViewerIcons, ionComponents } from './internals';

@Component({
  selector: 'rdlabo-photo-viewer',
  templateUrl: './photo-viewer.page.html',
  styleUrls: ['../../../src/lib/pages/core.scss', './photo-viewer.page.scss'],
  imports: [...ionComponents],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
/** Ionic modal page for zooming, browsing, and optionally deleting photos. */
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
  readonly labels = input<Partial<PhotoViewerLabels>>();
  readonly imageAlt = input<string | ((url: string, index: number) => string)>('');
  readonly toolbarColorScheme = input.required<PhotoToolbarColorScheme>();

  private readonly swiper = viewChild<ElementRef<SwiperContainer>>('swiper');
  protected readonly dictionary = computed<PhotoViewerLabels>(() => ({ ...dictionaryForViewer(), ...this.labels() }));

  private readonly watchSwipe$ = new Subscription();
  protected readonly modalCtrl = inject(ModalController);
  private readonly el = inject(ElementRef);
  private swiperInitialized = false;

  private readonly initializeSwiper = effect(() => {
    const swiper = this.swiper()?.nativeElement;
    if (!swiper || this.swiperInitialized) {
      return;
    }
    this.swiperInitialized = true;
    const index = this.index();
    Object.assign(swiper, {
      modules: [Navigation, Zoom, IonicSlides],
      initialSlide: index,
      slidesPerView: 1,
      pagination: {
        enabled: true,
        clickable: true,
      },
      zoom: true,
    });
    swiper.initialize();
    swiper.swiper.zoom.enable();
    swiper.swiper.activeIndex = index;
    swiper.swiper.update();
  });

  constructor() {
    register();
    initializeViewerIcons();
  }

  ngOnInit() {
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

          const slides = this.swiper()?.nativeElement.querySelectorAll('swiper-slide') ?? [];
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
    const imageUrls = this.imageUrls();
    if (imageUrls.length === 0) {
      return;
    }
    const activeIndex = this.swiper()?.nativeElement.swiper.activeIndex ?? this.index();
    const index = Math.min(imageUrls.length - 1, Math.max(0, Math.trunc(activeIndex)));
    void this.modalCtrl.dismiss({
      action: 'delete',
      index,
      value: imageUrls[index],
    } satisfies PhotoViewerResult);
  }

  protected resolveImageAlt(url: string, index: number): string {
    const alt = this.imageAlt();
    return typeof alt === 'function' ? alt(url, index) : alt;
  }
}
