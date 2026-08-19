Attach scroll-aware headers to Ionic content. Call this after [Installation](../README.md#installation).

- Demo: https://rdlabo-ionic-angular-library.netlify.app/main/scroll-header
- Source: https://github.com/rdlabo-dev/ionic-angular-library/blob/v21.6.2/projects/demo/src/app/scroll-header/scroll-header.page.html

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
<ion-header class="hidden"><ion-toolbar></ion-toolbar></ion-header>
<!-- set hidden header for safe-area -->
<ion-content rdlaboScrollHeader>
  <ion-header>
    <ion-toolbar>...</ion-toolbar>
    <!-- Default Header for display -->
  </ion-header>
  ...Your Content
</ion-content>
```
