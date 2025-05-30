import { contentChild, Directive, ElementRef, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { IonContent, IonHeader } from '@ionic/angular/standalone';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { fromEvent, Subscription } from 'rxjs';
import { waitFindDom } from '../util';

@Directive({
  selector: 'ion-content[rdlaboVirtualScrollHeader]',
})
export class VirtualScrollHeaderDirective implements OnInit, OnDestroy {
  readonly #elementRef = inject(ElementRef<IonContent>);

  readonly virtualScroll = contentChild(CdkVirtualScrollViewport);
  readonly scrollHeader = contentChild(IonHeader, { read: ElementRef });

  readonly #minScrollAmount = 16;
  readonly #nativeHeader = signal<HTMLElement | undefined>(undefined);
  readonly #scrollRefresher = signal<HTMLElement | undefined>(undefined);
  readonly #scrollHeaderSize = signal<number>(0);
  readonly #beforeScrollTop = signal<number>(0);
  readonly #scrollSubscription = new Subscription();

  async ngOnInit() {
    await Promise.all([
      waitFindDom(this.#elementRef.nativeElement, 'ion-header'),
      waitFindDom(this.#elementRef.nativeElement, 'cdk-virtual-scroll-viewport'),
    ]);

    this.#elementRef.nativeElement.classList.add('scroll-header-animated');

    if (
      this.#elementRef.nativeElement.previousElementSibling &&
      this.#elementRef.nativeElement.previousElementSibling.classList.contains('native-header')
    ) {
      this.#nativeHeader.set(this.#elementRef.nativeElement.previousElementSibling);
    }

    this.#scrollSubscription.add(
      fromEvent(this.virtualScroll()!.elementRef.nativeElement, 'scroll').subscribe(() => {
        this.onWindowScroll(this.virtualScroll()!.measureScrollOffset('top'));
      }),
    );
  }

  ngOnDestroy() {
    this.#scrollSubscription.unsubscribe();
  }

  onWindowScroll(scrollOffset: number) {
    if (this.scrollHeader() === undefined || this.virtualScroll() === undefined) {
      return;
    }

    if (this.#elementRef.nativeElement.classList.contains('fixed')) {
      // ion-headerに.fixedが指定されている場合は固定
      this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
      return;
    }

    if (!this.#scrollHeaderSize()) {
      // 表示サイズを挿入
      this.#scrollHeaderSize.set(this.scrollHeader()!.nativeElement.clientHeight);
      this.virtualScroll()!.elementRef.nativeElement.style.marginTop = this.scrollHeader()!.nativeElement.clientHeight * -1 + 'px';
      this.virtualScroll()!.elementRef.nativeElement.style.paddingTop = this.scrollHeader()!.nativeElement.clientHeight + 'px';

      this.#scrollRefresher.set(this.#elementRef.nativeElement.querySelector('ion-refresher'));
      if (this.#scrollRefresher()) {
        this.#scrollRefresher.update((v) => {
          v!.style.marginTop = this.scrollHeader()!.nativeElement.clientHeight + 'px';
          return v;
        });
      }
    }

    if (scrollOffset === 0) {
      // 上部にきたら解除
      this.#elementRef.nativeElement.classList.remove('scroll-header-sticky');
    }

    const scrollAmount = scrollOffset - this.#beforeScrollTop();
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
      if (scrollOffset > this.#scrollHeaderSize() / 1.5) {
        this.#elementRef.nativeElement.classList.add('scroll-header-sticky');
      }
    } else {
      // 下にスクロール
      if (scrollOffset <= this.#scrollHeaderSize() / 1.5) {
        this.#elementRef.nativeElement.classList.remove('scroll-header-hidden');
        this.#elementRef.nativeElement.classList.remove('scroll-header-sticky');
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
      }
    }

    this.#beforeScrollTop.set(scrollOffset);
  }
}
