# @rdlabo/ngx-cdk-scroll-strategies

This is strategies of dynamic item size for `@angular/cdk/scrolling`. This allows you set specify each item size in the array to be used for Virtual Scroll. Although the repository name includes “Ionic” this strategy only works with Angular.

This is a simple coding concept:

```html
<cdk-virtual-scroll-viewport [itemDynamicSizes]="[{ itemSize: 100 } , { itemSize: 80} , { itemSize: 90 } , { itemSize: 100}]">
  <div *cdkVirtualFor="let item of [100, 80, 90, 100]; trackBy: trackByFn" [style.height.px]="item">
    itemSize: {{ item }}
  </div>
</cdk-virtual-scroll-viewport>
```

Use `[itemDynamicSizes]` directive instead of `[itemSize]` or `[autosize]` directive. `[itemDynamicSizes]` value's type is `itemDynamicSize[]`.

This library is based largely on this blog: https://dev.to/georgii/virtual-scrolling-of-content-with-variable-height-with-angular-3a52


## Installation

```bash
npm install @rdlabo/ngx-cdk-scroll-strategies
```

## Usage

### Simple Usage

> This is a simple example of how to use it.

- Demo: https://rdlabo-ionic-angular-library.netlify.app/main/scroll-strategies/simple
- Source: https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/demo/src/app/scroll-strategies/pages/scroll-simple

```ts
import { CdkDynamicSizeVirtualScroll, itemDynamicSize } from '@rdlabo/ngx-cdk-scroll-strategies';

@Component({
  ...
  imports: [
    CdkDynamicSizeVirtualScroll
  ],
})
export class ScrollStrategiesPage implements OnInit {
  readonly items = signal<itemDynamicSize[]>([]);
  readonly dynamicSize = computed<itemDynamicSize[]>(() => {
    return this.items().map((item) => ({ trackId: item.trackId, itemSize: item.itemSize }));
  });
}
```

```html
<cdk-virtual-scroll-viewport [itemDynamicSizes]="dynamicSize()" minBufferPx="900" maxBufferPx="1350">
  <div *cdkVirtualFor="let item of items(); trackBy: trackByFn" class="dynamic-item" [style.height.px]="item.itemSize">
    itemSize: {{ item.itemSize }}
  </div>
</cdk-virtual-scroll-viewport>
```

Other than this, it works the same way as `@angular/cdk/scrolling`.

### Advanced Usage

> This is a practical demo. Make scroll items separate components and get a height for each component.
> It is difficult without basic knowledge of Angular.

- Demo: https://rdlabo-ionic-angular-library.netlify.app/main/scroll-strategies/advanced
- Source: https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/demo/src/app/scroll-strategies/pages/scroll-advanced


### Reverse Usage

> This is a demo for reverse scrolling like WeChat.

- Demo: https://rdlabo-ionic-angular-library.netlify.app/main/scroll-strategies/reverse
- Source: https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/demo/src/app/scroll-strategies/pages/scroll-reverse

If reverse scroll, add `isReverse` directive to `cdk-virtual-scroll-viewport` tag.

```html
<cdk-virtual-scroll-viewport [itemDynamicSizes]="dynamicSize()" [isReverse]="true" minBufferPx="900" maxBufferPx="1350">
  <div class="reverse-items">
    <div *cdkVirtualFor="let item of items(); trackBy: trackByFn" class="dynamic-item" [style.height.px]="item.itemSize">
      itemSize: {{ item.itemSize }}
    </div>
  </div>
</cdk-virtual-scroll-viewport>
```

Add css to `cdk-virtual-scroll-viewport.reverse-scroll` at global css file like `styles.css`.

```css
cdk-virtual-scroll-viewport {
  width: 100%;
  height: 100%;

  // .reverse-scroll class is added from this directive.
  &.reverse-scroll {
    display: flex;
    flex-direction: column-reverse;

    .cdk-virtual-scroll-content-wrapper {
      top: auto;
      bottom: 0;
    }
  }
}
```

And add item wrapper. `div.reverse-items` class is example. You can decide this.

```css
div.reverse-items {
  height: 100%;
  display: flex;
  flex-direction: column-reverse;

  position: relative;
  bottom: 0;
}
```

__In Reverse Scroll, CdkVirtualScrollViewport's measureScrollOffset does not work. Please use the scrollOffset of this directive.__
https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/scroll-strategies/src/lib/dynamic-size-virtual-scroll-strategy.ts#L383-L386

### Optional

This package contains a Helper Service that simplifies development with Virtual Scroll.

```ts
import { DynamicSizeVirtualScrollService } from '@rdlabo/ngx-cdk-scroll-strategies';
```

Detail is here: https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/scroll-strategies/src/lib/dynamic-size-virtual-scroll.service.ts

## FQA
### Why don't use `autosize` directive?

`autosize` directive use average item size. This is not support "item size is changed" "item is removed". Because don't have item size cache.

https://github.com/angular/components/blob/main/src/cdk-experimental/scrolling/auto-size-virtual-scroll.ts#L49C3-L59

Dynamic size can be specified for more flexible application design.
