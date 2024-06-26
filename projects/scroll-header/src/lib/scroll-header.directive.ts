import { Directive, ElementRef, HostListener, inject, OnInit } from '@angular/core';
import { IonContent, ScrollDetail } from '@ionic/angular/standalone';

@Directive({
  selector: 'ion-content[rdlaboScrollHeader]',
  standalone: true,
})
export class ScrollHeaderDirective implements OnInit {
  #elementRef = inject(ElementRef<IonContent>);
  #minScrollAmount = 16;
  #nativeHeader: HTMLElement | undefined;
  #scrollHeader: HTMLElement | undefined;
  #scrollHeaderSize: number | undefined;
  #beforeScrollTop: number = 0;

  constructor() {}

  async ngOnInit() {
    await this.#waitFindDom(this.#elementRef.nativeElement, 'ion-header');

    this.#elementRef.nativeElement.scrollEvents = true;
    this.#scrollHeader = this.#elementRef.nativeElement.querySelector('ion-header');
    if (
      this.#elementRef.nativeElement.previousElementSibling &&
      this.#elementRef.nativeElement.previousElementSibling.classList.contains('native-header')
    ) {
      this.#nativeHeader = this.#elementRef.nativeElement.previousElementSibling;
    }
  }

  @HostListener('ionScroll', ['$event'])
  onWindowScroll($event: CustomEvent<ScrollDetail>) {
    if (this.#scrollHeader === undefined) {
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
    }

    if ($event.detail.scrollTop === 0) {
      // 上部にきたら解除
      this.#elementRef.nativeElement.classList.remove('scroll-header-sticky');
      this.#elementRef.nativeElement.classList.remove('scroll-header-animated');
    }

    const scrollAmount = $event.detail.scrollTop - this.#beforeScrollTop;
    if (Math.abs(scrollAmount) < this.#minScrollAmount) {
      return;
    }

    if (scrollAmount < 0) {
      // 上へスクロール
      this.#elementRef.nativeElement.classList.remove('scroll-header-hidden');
      if (this.#nativeHeader) {
        this.#nativeHeader.classList.remove('scroll-header-hidden');
      }
      if ($event.detail.scrollTop > this.#scrollHeaderSize) {
        this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
        this.#elementRef.nativeElement.classList.add('scroll-header-animated');
      }
    } else {
      // 下にスクロール
      if ($event.detail.scrollTop <= this.#scrollHeaderSize) {
        this.#elementRef.nativeElement.classList.remove('scroll-header-hidden');
        this.#elementRef.nativeElement.classList.remove('scroll-header-sticky');
        this.#elementRef.nativeElement.classList.remove('scroll-header-animated');
        if (this.#nativeHeader) {
          this.#nativeHeader.classList.remove('scroll-header-hidden');
        }
      } else {
        this.#elementRef.nativeElement.classList.add('scroll-header-hidden');
        this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
        if (this.#nativeHeader) {
          this.#nativeHeader.classList.add('scroll-header-hidden');
        }
        setTimeout(() => this.#elementRef.nativeElement.classList.add('scroll-header-animated'));
      }
    }

    this.#beforeScrollTop = $event.detail.scrollTop;
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
