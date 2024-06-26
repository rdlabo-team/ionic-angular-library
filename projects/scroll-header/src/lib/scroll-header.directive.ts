import { Directive, ElementRef, HostListener, inject, OnInit } from '@angular/core';
import { IonContent, ScrollDetail } from '@ionic/angular/standalone';

@Directive({
  selector: '[rdlaboScrollHeader]',
  standalone: true,
})
export class ScrollHeaderDirective implements OnInit {
  #elementRef = inject(ElementRef<IonContent>);
  #minScrollAmount = 16;
  #scrollHeader: HTMLElement | undefined;
  #scrollHeaderSize: number | undefined;
  #beforeScrollTop: number = 0;

  constructor() {}

  ngOnInit() {
    this.#elementRef.nativeElement.scrollEvents = true;
    this.#scrollHeader = this.#elementRef.nativeElement.querySelector('ion-header');
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
      } else {
        this.#elementRef.nativeElement.classList.add('scroll-header-hidden');
        this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
        setTimeout(() => this.#elementRef.nativeElement.classList.add('scroll-header-animated'));
      }
    }

    this.#beforeScrollTop = $event.detail.scrollTop;
  }
}
