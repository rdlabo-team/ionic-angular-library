import { Directive, ElementRef, inject, OnInit } from '@angular/core';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

@Directive({
  selector: 'cdk-virtual-scroll-viewport[rdlaboFixVirtualScrollElement]',
})
export class FixVirtualScrollElementDirective implements OnInit {
  readonly #elementRef = inject(ElementRef<CdkVirtualScrollViewport>);

  ngOnInit() {
    const nativeEl = this.#elementRef.nativeElement;
    if (nativeEl) {
      const last = nativeEl.lastElementChild;
      if (nativeEl.firstElementChild && last) {
        nativeEl.replaceChild(nativeEl.firstElementChild, nativeEl.lastElementChild);
        nativeEl.insertBefore(last, nativeEl.firstElementChild);
      }
    }
  }
}
