Hidden safe-area headers and always-visible native headers.

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

```diff
- <ion-header class="hidden"><ion-toolbar></ion-toolbar></ion-header>
+ <ion-header class="native-header">
+   <ion-toolbar><ion-title>Native Header</ion-title></ion-toolbar>
+ </ion-header>
```
