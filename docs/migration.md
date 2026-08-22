# Library migration guide

This guide covers consumer-facing changes in the packages published from this repository. It does not replace the upstream [Angular update guide](https://angular.dev/update-guide), [Ionic breaking-change guide](https://github.com/ionic-team/ionic-framework/blob/main/BREAKING.md), or [Capacitor upgrade guides](https://capacitorjs.com/docs/updating/overview).

## v21 to v22

### Compatibility requirements

Version 22 supports Angular 21 and 22. The kit, photo-editor, and scroll-header packages require Ionic 9; scroll-strategies requires only Angular and Angular CDK. Native kit and photo-editor features require Capacitor 7 or 8. Upgrade the host application with the upstream tools first, then update only the rdlabo packages it uses. Keep rdlabo packages on the same release line when an application uses more than one of them.

While v22 is available under the npm `beta` dist-tag, install the prerelease with:

```bash
npm install @rdlabo/ionic-angular-kit@beta \
  @rdlabo/ionic-angular-photo-editor@beta \
  @rdlabo/ionic-angular-scroll-header@beta \
  @rdlabo/ngx-cdk-scroll-strategies@beta
```

After stable v22 is published, use `@^22` instead of `@beta`. Omit packages that the application does not use. Release maintainers must update this prerelease instruction when promoting v22 to npm `latest`.

### @rdlabo/ionic-angular-photo-editor

#### Choose the header button scheme

`PhotoEditorPage` and `PhotoViewerPage` now require `headerButtonColorScheme`. The library cannot infer the final `ion-toolbar` appearance after application CSS, translucency, and runtime theme overrides are applied.

Use `dark` for a dark or black toolbar and `light` for a light or white toolbar. Define typed props before passing them to Ionic because `ModalController` does not enforce the component's input types.

```typescript
import { PhotoEditorPage, PhotoEditorProps } from '@rdlabo/ionic-angular-photo-editor';

const componentProps = {
  value,
  headerButtonColorScheme: 'dark',
} satisfies PhotoEditorProps;

await modalController.create({
  component: PhotoEditorPage,
  componentProps,
});
```

```typescript
import { PhotoViewerPage, PhotoViewerProps } from '@rdlabo/ionic-angular-photo-editor';

const componentProps = {
  imageUrls,
  headerButtonColorScheme: 'dark',
} satisfies PhotoViewerProps;

await modalController.create({
  component: PhotoViewerPage,
  componentProps,
});
```

`PhotoViewerProps.imageUrls` is now correctly declared as required. It was already a required component input, so ensure every viewer invocation supplies it.

#### Update direct-template selectors

The public components now use package-prefixed selectors:

| Before               | After                   |
| -------------------- | ----------------------- |
| `<app-editor-image>` | `<rdlabo-photo-editor>` |
| `<app-photo-image>`  | `<rdlabo-photo-viewer>` |

No selector update is needed when presenting `PhotoEditorPage` or `PhotoViewerPage` by component class through `ModalController`.

#### Optional iOS 26 theme integration

Applications using `@rdlabo/ionic-theme-ios26` v3 can import the photo-editor adapter after the Ionic and iOS 26 theme styles:

```scss
@import '@rdlabo/ionic-theme-ios26/dist/css/ionic-theme-ios26.css';
@import '@ionic/angular/css/palettes/dark.class.css';
@import '@rdlabo/ionic-theme-ios26/dist/css/ionic-theme-ios26-dark-class.css';
@import '@rdlabo/ionic-angular-photo-editor/css/ios26-header-button-color-scheme.css';
```

Do not import the adapter when the application does not use the iOS 26 theme. See the photo editor [theme guide](../projects/photo-editor/docs/theme.md) for color overrides and alternative dark-mode imports.

### @rdlabo/ionic-angular-kit

Version 22 changes the supported host framework range but does not rename or remove kit public APIs. After satisfying the compatibility requirements, existing kit imports and provider configuration remain valid.

### @rdlabo/ionic-angular-scroll-header

Version 22 has no package-specific API migration. Existing `rdlaboScrollHeader`, `rdlaboVirtualScrollHeader`, and `rdlaboFixVirtualScrollElement` usages remain valid after the dependency update.

### @rdlabo/ngx-cdk-scroll-strategies

Version 22 has no package-specific API migration. Existing dynamic-size virtual-scroll configuration remains valid after the dependency update.

### Verification

After applying the relevant package migrations, run the host application's normal checks and exercise the affected UI on each supported platform. For photo-editor, verify both editor and viewer modals against every toolbar color used by the application.
