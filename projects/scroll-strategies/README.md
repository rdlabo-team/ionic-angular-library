# @rdlabo/ngx-cdk-scroll-strategies

This is strategies of dynamic item size for `@angular/cdk/scrolling`. This allows you set specify each item size in the array to be used for Virtual Scroll.

This is a simple coding concept:

```html
<cdk-virtual-scroll-viewport [itemDynamicSizes]="[{ itemSize: 100 } , { itemSize: 80} , { itemSize: 90 } , { itemSize: 100}]">
  <div *cdkVirtualFor="let item of [100, 80, 90, 100]; trackBy: trackByFn" [style.height.px]="item">
    itemSize: {{ item }}
  </div>
</cdk-virtual-scroll-viewport>
```

Use `[itemDynamicSizes]` directive instead of `[itemSize]` or `[autosize]` directive. `[itemDynamicSizes]` value's type is `itemDynamicSize[]`.


## Installation

```bash
npm install @rdlabo/ngx-cdk-scroll-strategies
```

## Usage

- Demo: https://rdlabo-ionic-angular-library.netlify.app/tabs/tab4
- Source: https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/demo/src/app/scroll-strategies/scroll-strategies.page.ts

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

Other than this, it works the same way as `@angular/cdk/scroll`.


# FQA
## Why don't use `autosize` directive?

`autosize` directive use average item size. This is not support "item size is changed" "item is removed". Because don't have item size cache.

https://github.com/angular/components/blob/main/src/cdk-experimental/scrolling/auto-size-virtual-scroll.ts#L49C3-L59

Dynamic size can be specified for more flexible application design.
