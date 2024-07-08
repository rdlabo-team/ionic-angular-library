import { Directive, ElementRef, inject, OnInit } from '@angular/core';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

@Directive({
  selector: 'cdk-virtual-scroll-viewport[rdlaboFixVirtualScrollElement]',
  standalone: true,
})
export class FixVirtualScrollElementDirective implements OnInit {
  #elementRef = inject(ElementRef<CdkVirtualScrollViewport>);
  constructor() {}

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
