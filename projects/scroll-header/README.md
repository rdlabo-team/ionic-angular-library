# @rdlabo/ionic-angular-scroll-header

This is directive for scroll with Header.

## Installation

```bash
npm install @rdlabo/ionic-angular-scroll-header
```

And import CSS for directive:
```diff:scss
+ @import '@rdlabo/ionic-angular-scroll-header/css/scroll-header.directive.css';

+ /* If you use cdk virtual scroll */
+ cdk-virtual-scroll-viewport {
+   width: 100%;
+   height: 100%;
+   .cdk-virtual-scroll-content-wrapper {
+     padding-top: inherit;
+   }
+ }
```

## Usage

### Scroll of IonContent

Demo: https://rdlabo-ionic-angular-library.netlify.app/tabs/tab2
Source: https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/demo/src/app/scroll-header/scroll-header.page.html

```ts
import { ScrollHeaderDirective } from '@rdlabo/ionic-angular-scroll-header';
@Component({
  ...
  imports: [
    ScrollHeaderDirective
  ],
})
```

```html
<ion-header class="hidden"><ion-toolbar></ion-toolbar></ion-header> <!-- set hidden header for safe-area -->
<ion-content rdlaboScrollHeader>
  <ion-header>
    <ion-toolbar>...</ion-toolbar> <!-- Default Header for display -->
  </ion-header>
  ...Your Content
</ion-content>
```

### Scroll of CdkVirtualScroll (Angular Material)

Demo: https://rdlabo-ionic-angular-library.netlify.app/tabs/tab3
Source: https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/demo/src/app/virtual-scroll-header/virtual-scroll-header.page.html

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
<ion-header class="hidden"><ion-toolbar></ion-toolbar></ion-header> <!-- set hidden header for safe-area -->
<ion-content rdlaboVirtualScrollHeader>
  <ion-header>
    <ion-toolbar>...</ion-toolbar> <!-- Default Header for display -->
  </ion-header>
  <cdk-virtual-scroll-viewport minBufferPx="900" maxBufferPx="1350" [itemSize]="44" class="ion-content-scroll-host">
    ...Your Content
  </cdk-virtual-scroll-viewport>
</ion-content>
```

# FQA
## Why do I need to set hidden header for safe-area?
Of course, it is also possible to set a safe-area in ion-content as follows.

```css
ion-content {
  padding-top: var(--ion-safe-area-top, 0);
}
```

But I preferred to explicitly set up ion-header and ion-toolbar for safe-area.

## I also need a Header that is always visible, apart from the Header that follows Scroll and hides it

it is possible: by adding `native-header` to the class name, you can have two Headers more smoothly.

```diff:html
- <ion-header class="hidden"><ion-toolbar></ion-toolbar></ion-header>
+ <ion-header class="native-header">
+   <ion-toolbar><ion-title>Native Header</ion-title></ion-toolbar>
+ </ion-header>
```
