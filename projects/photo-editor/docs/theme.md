Override the editor colors after [Installation](../README.md#installation).

Default color is set, but user can overwrite it: https://github.com/rdlabo-dev/ionic-angular-library/blob/v21.6.2/projects/photo-editor/src/lib/pages/core.scss

## How to overwrite

```scss
:root {
  --ion-photo-editor-background: #2a2a2a;
  --ion-photo-editor-background-tint: #414141;

  --ion-photo-editor-color: #f0f0f0;
  --ion-photo-editor-color-tint: #dbdbdb;

  --ion-photo-editor-primary: #4d8dff;
  --ion-photo-editor-danger: #f24c58;
  --ion-photo-editor-success: #2dd55b;

  --ion-photo-editor-header-button-color-on-light: #222428;
  --ion-photo-editor-header-button-color-on-dark: #f4f5f8;
}
```

## Header button color scheme

`PhotoEditorPage` and `PhotoViewerPage` require `headerButtonColorScheme: 'light' | 'dark'` in their modal `componentProps`. Select `dark` for a dark/black `ion-toolbar` and `light` for a light/white toolbar. The consumer must choose because the library cannot reliably infer the final toolbar appearance from CSS, translucency, or runtime theme overrides.

For `@rdlabo/ionic-theme-ios26` v3, import the optional integration stylesheet after the iOS 26 theme and dark-mode styles:

```scss
@import '@rdlabo/ionic-theme-ios26/dist/css/ionic-theme-ios26.css';
@import '@ionic/angular/css/palettes/dark.class.css';
@import '@rdlabo/ionic-theme-ios26/dist/css/ionic-theme-ios26-dark-class.css';
@import '@rdlabo/ionic-angular-photo-editor/css/ios26-header-button-color-scheme.css';
```

Use the matching Always or System dark-mode import instead when appropriate. The photo-editor integration stylesheet must remain last so its local header scheme can override the ambient application scheme. Applications that do not use the iOS 26 theme should not import this optional stylesheet; they receive only the regular Ionic button foreground-color switch.

## Migrating to v22

`headerButtonColorScheme` is required in v22. Use a typed props object so Ionic's loose `componentProps` type cannot hide an omitted value:

```typescript
import { PhotoEditorProps } from '@rdlabo/ionic-angular-photo-editor';

const componentProps = {
  value,
  headerButtonColorScheme: 'dark',
} satisfies PhotoEditorProps;
```
