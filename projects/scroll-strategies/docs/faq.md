### Why don't use `autosize` directive?

`autosize` directive use average item size. This is not support "item size is changed" "item is removed". Because don't have item size cache.

https://github.com/angular/components/blob/main/src/cdk-experimental/scrolling/auto-size-virtual-scroll.ts#L49C3-L59

Dynamic size can be specified for more flexible application design.
