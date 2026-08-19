Coordinate headers with Angular CDK virtual viewports. Call this after [Installation](../README.md#installation).

- Demo: https://rdlabo-ionic-angular-library.netlify.app/main/virtual-scroll-header
- Source: https://github.com/rdlabo-dev/ionic-angular-library/blob/v21.6.2/projects/demo/src/app/virtual-scroll-header/virtual-scroll-header.page.html

```ts
import { VirtualScrollHeaderDirective } from '@rdlabo/ionic-angular-scroll-header';

@Component({
  ...
  imports: [
    VirtualScrollHeaderDirective
  ],
})
```

```html
<ion-header class="hidden"><ion-toolbar></ion-toolbar></ion-header>
<!-- set hidden header for safe-area -->
<ion-content rdlaboVirtualScrollHeader>
  <ion-header>
    <ion-toolbar>...</ion-toolbar>
    <!-- Default Header for display -->
  </ion-header>
  <cdk-virtual-scroll-viewport
    minBufferPx="900"
    maxBufferPx="1350"
    [itemSize]="44"
    class="ion-content-scroll-host"
  >
    ...Your Content
  </cdk-virtual-scroll-viewport>
</ion-content>
```

### Fix https://github.com/angular/components/issues/27104

> bug(COMPONENT): CDK Virtual Scroller jump back/flickers to items on top #27104

```ts
import { FixVirtualScrollElementDirective } from '@rdlabo/ionic-angular-scroll-header';

@Component({
  ...
  imports: [
  FixVirtualScrollElementDirective
  ],
})
```

```html
<ion-content>
  <cdk-virtual-scroll-viewport
    rdlaboFixVirtualScrollElement
    minBufferPx="900"
    maxBufferPx="1350"
    [itemSize]="44"
    class="ion-content-scroll-host"
  >
    ...Your Content
  </cdk-virtual-scroll-viewport>
</ion-content>
```
