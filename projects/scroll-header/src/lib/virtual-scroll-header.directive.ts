import { contentChild, Directive, ElementRef, inject, OnDestroy, OnInit } from '@angular/core';
import { IonContent } from '@ionic/angular/standalone';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { fromEvent, Subscription } from 'rxjs';

@Directive({
  selector: '[appVirtualScrollHeader]',
  standalone: true,
})
export class VirtualScrollHeaderDirective implements OnInit, OnDestroy {
  #elementRef = inject(ElementRef<IonContent>);
  virtualScroll = contentChild(CdkVirtualScrollViewport);

  #minScrollAmount = 16;
  #nativeHeader: HTMLElement | undefined;
  #scrollHeader: HTMLElement | undefined;
  #scrollRefresher: HTMLElement | undefined;
  #scrollHeaderSize: number | undefined;
  #beforeScrollTop: number = 0;
  #scrollSubscription: Subscription | undefined;

  constructor() {}

  async ngOnInit() {
    await Promise.all([
      this.#waitFindDom(this.#elementRef.nativeElement, 'ion-header'),
      this.#waitFindDom(this.#elementRef.nativeElement, 'cdk-virtual-scroll-viewport'),
    ]);

    this.#scrollHeader = this.#elementRef.nativeElement.querySelector('ion-header');
    this.#elementRef.nativeElement.classList.add('scroll-header-animated');

    if (
      this.#elementRef.nativeElement.previousElementSibling &&
      this.#elementRef.nativeElement.previousElementSibling.classList.contains('native-header')
    ) {
      this.#nativeHeader = this.#elementRef.nativeElement.previousElementSibling;
    }

    this.#scrollSubscription = fromEvent(this.virtualScroll()!.elementRef.nativeElement, 'scroll').subscribe(() => {
      this.onWindowScroll(this.virtualScroll()!.measureScrollOffset('top'));
    });
  }

  ngOnDestroy() {
    this.#scrollSubscription?.unsubscribe();
  }

  onWindowScroll(scrollOffset: number) {
    if (this.#scrollHeader === undefined || this.virtualScroll() === undefined) {
      return;
    }

    if (this.#elementRef.nativeElement.classList.contains('fixed')) {
      // ion-headerに.fixedが指定されている場合は固定
      this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
      return;
    }

    if (!this.#scrollHeaderSize) {
      // 表示サイズを挿入
      this.#scrollHeaderSize = this.#scrollHeader.clientHeight;
      this.virtualScroll()!.elementRef.nativeElement.style.marginTop = this.#scrollHeader.clientHeight * -1 + 'px';
      this.virtualScroll()!.elementRef.nativeElement.style.paddingTop = this.#scrollHeader.clientHeight + 'px';

      this.#scrollRefresher = this.#elementRef.nativeElement.querySelector('ion-refresher');
      if (this.#scrollRefresher) {
        this.#scrollRefresher.style.marginTop = this.#scrollHeader.clientHeight + 'px';
      }
    }

    if (scrollOffset === 0) {
      // 上部にきたら解除
      this.#elementRef.nativeElement.classList.remove('scroll-header-sticky');
    }

    const scrollAmount = scrollOffset - this.#beforeScrollTop;
    if (Math.abs(scrollAmount) < this.#minScrollAmount) {
      return;
    }

    if (scrollAmount < 0) {
      // 上へスクロール
      this.#elementRef.nativeElement.classList.remove('scroll-header-hidden');
      if (this.#nativeHeader) {
        this.#nativeHeader.classList.remove('scroll-header-hidden');
      }
      if (scrollOffset > this.#scrollHeaderSize / 1.5) {
        this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
      }
    } else {
      // 下にスクロール
      if (scrollOffset <= this.#scrollHeaderSize / 1.5) {
        this.#elementRef.nativeElement.classList.remove('scroll-header-hidden');
        this.#elementRef.nativeElement.classList.remove('scroll-header-sticky');
        if (this.#nativeHeader) {
          this.#nativeHeader.classList.remove('scroll-header-hidden');
        }
      } else {
        this.#elementRef.nativeElement.classList.add('scroll-header-hidden');
        this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
        if (this.#nativeHeader) {
          this.#nativeHeader.classList.add('scroll-header-hidden');
        }
      }
    }

    this.#beforeScrollTop = scrollOffset;
  }

  #waitFindDom(nativeElement: HTMLElement, selector: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const find = nativeElement.querySelector(selector);
        if (find) {
          clearInterval(interval);
          resolve();
        }
      });
    });
  }
}
