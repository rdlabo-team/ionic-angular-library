import { contentChild, Directive, ElementRef, HostListener, inject, OnInit, signal } from '@angular/core';
import { IonContent, IonHeader, ScrollDetail } from '@ionic/angular/standalone';
import { waitFindDom } from './helper';

@Directive({
  selector: 'ion-content[rdlaboScrollHeader]',
  standalone: true,
})
export class ScrollHeaderDirective implements OnInit {
  readonly #elementRef = inject(ElementRef<IonContent>);

  readonly scrollHeader = contentChild(IonHeader, { read: ElementRef });
  readonly #nativeHeader = signal<HTMLElement | undefined>(undefined);
  readonly #scrollHeaderSize = signal<number>(0);
  readonly #beforeScrollTop = signal<number>(0);

  readonly #minScrollAmount = 16;

  constructor() {}

  async ngOnInit() {
    await waitFindDom(this.#elementRef.nativeElement, 'ion-header');
    this.#elementRef.nativeElement.scrollEvents = true;
    if (
      this.#elementRef.nativeElement.previousElementSibling &&
      this.#elementRef.nativeElement.previousElementSibling.classList.contains('native-header')
    ) {
      this.#nativeHeader.set(this.#elementRef.nativeElement.previousElementSibling);
    }
  }

  @HostListener('ionScroll', ['$event'])
  onWindowScroll($event: CustomEvent<ScrollDetail>) {
    if (this.scrollHeader() === undefined) {
      return;
    }

    if (this.#elementRef.nativeElement.classList.contains('fixed')) {
      // ion-headerに.fixedが指定されている場合は固定
      this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
      return;
    }

    if (!this.#scrollHeaderSize()) {
      // 表示サイズを挿入
      this.#scrollHeaderSize.set(this.scrollHeader()?.nativeElement.clientHeight);
    }

    if ($event.detail.scrollTop === 0) {
      // 上部にきたら解除
      this.#elementRef.nativeElement.classList.remove('scroll-header-sticky');
      this.#elementRef.nativeElement.classList.remove('scroll-header-animated');
    }

    const scrollAmount = $event.detail.scrollTop - this.#beforeScrollTop();
    if (Math.abs(scrollAmount) < this.#minScrollAmount) {
      return;
    }

    if (scrollAmount < 0) {
      // 上へスクロール
      this.#elementRef.nativeElement.classList.remove('scroll-header-hidden');
      if (this.#nativeHeader()) {
        this.#nativeHeader.update((v) => {
          v!.classList.remove('scroll-header-hidden');
          return v;
        });
      }
      if ($event.detail.scrollTop > this.#scrollHeaderSize()) {
        this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
        this.#elementRef.nativeElement.classList.add('scroll-header-animated');
      }
    } else {
      // 下にスクロール
      if ($event.detail.scrollTop <= this.#scrollHeaderSize()) {
        this.#elementRef.nativeElement.classList.remove('scroll-header-hidden');
        this.#elementRef.nativeElement.classList.remove('scroll-header-sticky');
        this.#elementRef.nativeElement.classList.remove('scroll-header-animated');
        if (this.#nativeHeader()) {
          this.#nativeHeader.update((v) => {
            v!.classList.remove('scroll-header-hidden');
            return v;
          });
        }
      } else {
        this.#elementRef.nativeElement.classList.add('scroll-header-hidden');
        this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
        if (this.#nativeHeader()) {
          this.#nativeHeader.update((v) => {
            v!.classList.add('scroll-header-hidden');
            return v;
          });
        }
        setTimeout(() => this.#elementRef.nativeElement.classList.add('scroll-header-animated'));
      }
    }

    this.#beforeScrollTop.set($event.detail.scrollTop);
  }
}
