import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  inject,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
  ViewEncapsulation,
} from '@angular/core';
import { IonicSlides, ModalController } from '@ionic/angular/standalone';
import { Navigation, Zoom } from 'swiper/modules';
import { fromEvent, Subscription, throttleTime, withLatestFrom, zipWith } from 'rxjs';
import { NgFor, NgIf } from '@angular/common';
import { SwiperContainer } from 'swiper/element';
import { ionComponents } from '../ion-components';
import { HelperService } from '../service/helper.service';
import { IDictionaryForEditor, IDictionaryForViewer, IPhotoViewerDismiss } from '../types';
import { register } from 'swiper/element/bundle';
import { dictionaryForEditor, dictionaryForViewer } from '../dictionaries';

@Component({
  selector: 'app-photo-image',
  templateUrl: './photo-viewer.page.html',
  styleUrls: ['./core.scss', './photo-viewer.page.scss'],
  standalone: true,
  imports: [NgFor, NgIf, ...ionComponents],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class PhotoViewerPage implements OnInit, OnDestroy {
  protected dictionary: IDictionaryForViewer = dictionaryForViewer();

  @Input() imageUrls: string[] = [];
  @Input() index: number = 0;
  @Input() isCircle = false;
  @Input() enableDelete = false;
  @Input() set labels(d: IDictionaryForViewer) {
    this.dictionary = Object.assign(this.dictionary, d);
  }

  @ViewChild('swiper') swiper!: ElementRef<SwiperContainer>;

  watchSwipe$!: Subscription;
  readonly modalCtrl = inject(ModalController);
  private readonly el = inject(ElementRef);
  private readonly service = inject(HelperService);

  constructor() {
    register();
    this.service.initializeViewerIcons();
  }

  async ngOnInit() {
    this.service.waitToFindDom(this.el.nativeElement, 'swiper-container').then(() => {
      Object.assign(this.swiper.nativeElement, {
        modules: [Navigation, Zoom, IonicSlides],
        initialSlide: this.index,
        slidesPerView: 1,
        pagination: {
          enabled: true,
          clickable: true,
        },
        zoom: true,
      });
      this.swiper.nativeElement.initialize();
      this.swiper.nativeElement.swiper.zoom.enable();

      this.swiper.nativeElement.swiper.activeIndex = this.index;
      this.swiper.nativeElement.swiper.update();
    });

    this.watchSwipe$ = fromEvent<TouchEvent>(this.el.nativeElement, 'touchstart')
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

        const slides = (this.swiper as any).nativeElement.querySelectorAll('swiper-slide') as HTMLElement[];
        const isZoomed = Array.from(slides).find((slide: HTMLElement) => {
          return ['swiper-slide-zoomed', 'swiper-slide-active'].every((c) => slide.classList.contains(c));
        });

        const threshold = touchmove.touches ? -50 : -5;

        if (!isZoomed && Math.abs(xDiff) < Math.abs(threshold) && yDiff < threshold && touchstart.timeStamp <= touchmove.timeStamp) {
          this.watchSwipe$.unsubscribe();
          this.modalCtrl.dismiss();
        }
      });
  }

  ngOnDestroy() {
    if (this.watchSwipe$ && !this.watchSwipe$.closed) {
      this.watchSwipe$.unsubscribe();
    }
  }

  remove() {
    this.modalCtrl.dismiss({ delete: true } as IPhotoViewerDismiss);
  }
}
