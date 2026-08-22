# Library migration guide

This guide covers consumer-facing changes in the packages published from this repository. It does not replace the upstream [Angular update guide](https://angular.dev/update-guide), [Ionic breaking-change guide](https://github.com/ionic-team/ionic-framework/blob/main/BREAKING.md), or [Capacitor upgrade guides](https://capacitorjs.com/docs/updating/overview).

## v21 to v22

### Compatibility requirements

Version 22 supports Angular 21 and 22. The kit, photo-editor, and scroll-header packages require Ionic 9; scroll-strategies requires only Angular and Angular CDK. Native kit and photo-editor features require Capacitor 7 or 8. **The minimum iOS/iPadOS deployment target is 16.4.** Upgrade the host application with the upstream tools first, then update only the rdlabo packages it uses. Keep rdlabo packages on the same release line when an application uses more than one of them.

Set `platform :ios, '16.4'` in the application Podfile and `IPHONEOS_DEPLOYMENT_TARGET = 16.4` in the Xcode project. This minimum is required because the obsolete auth autofill workaround is removed only after the corresponding WebKit fix shipped in the iOS 16.4 generation.

While v22 is available under the npm `beta` dist-tag, install the prerelease with:

```bash
npm install @rdlabo/ionic-angular-kit@beta \
  @rdlabo/ionic-angular-photo-editor@beta \
  @rdlabo/ionic-angular-scroll-header@beta \
  @rdlabo/ngx-cdk-scroll-strategies@beta
```

After stable v22 is published, use `@^22` instead of `@beta`. Omit packages that the application does not use. Release maintainers must update this prerelease instruction when promoting v22 to npm `latest`.

### @rdlabo/ionic-angular-photo-editor

#### Split entry points

Components and services moved to secondary entry points. Import types and configuration from the root package only.

| Before (v21)                                                            | After (v22)                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `import { PhotoEditorPage } from '@rdlabo/ionic-angular-photo-editor'`  | `import { PhotoEditorPage } from '@rdlabo/ionic-angular-photo-editor/editor'`               |
| `import { PhotoViewerPage } from '@rdlabo/ionic-angular-photo-editor'`  | `import { PhotoViewerPage } from '@rdlabo/ionic-angular-photo-editor/viewer'`               |
| `import { PhotoFileService } from '@rdlabo/ionic-angular-photo-editor'` | `import { PhotoFileService } from '@rdlabo/ionic-angular-photo-editor/file'`                |
| —                                                                       | `import { providePhotoEditor, PhotoEditorProps } from '@rdlabo/ionic-angular-photo-editor'` |

Optional implementations are explicit adapters in v22:

```typescript
import { providePhotoEditor } from '@rdlabo/ionic-angular-photo-editor';
import { createTuiImageEditor } from '@rdlabo/ionic-angular-photo-editor/editor/tui';
import { loadCapacitorPhotoCamera } from '@rdlabo/ionic-angular-photo-editor/file/capacitor';

export const appConfig = {
  providers: [
    providePhotoEditor({
      createImageEditor: createTuiImageEditor,
      loadCamera: loadCapacitorPhotoCamera, // omit for browser-only applications
    }),
  ],
};
```

Install `tui-image-editor` only when importing `/editor/tui`, `@capacitor/camera` only when importing `/file/capacitor`, and `swiper` only when importing `/viewer`. The root, `/editor`, and `/file` entry points no longer hide runtime imports of these optional peers. Without the corresponding configured adapter, editing/resizing or native selection fails with `PhotoLoadError('unavailable')`.

#### Add the required toolbarColorScheme

Both modals require the new `toolbarColorScheme` prop in v22. Version 21 did not expose a toolbar color-scheme prop, so add it to every editor and viewer presentation. Choose `dark` for a dark/black `ion-toolbar` and `light` for a light/white toolbar; only the consuming application can determine the toolbar appearance.

`PhotoViewerProps.imageUrls` is also required in v22; it was optional in the v21 declaration. Pass the current image array explicitly, including `[]` when there are no images.

```typescript
import { PhotoEditorProps } from '@rdlabo/ionic-angular-photo-editor';
import { PhotoEditorPage } from '@rdlabo/ionic-angular-photo-editor/editor';

const componentProps = {
  value,
  toolbarColorScheme: 'dark',
} satisfies PhotoEditorProps;

await modalController.create({ component: PhotoEditorPage, componentProps });
```

```typescript
import { PhotoViewerProps } from '@rdlabo/ionic-angular-photo-editor';
import { PhotoViewerPage } from '@rdlabo/ionic-angular-photo-editor/viewer';

const componentProps = {
  imageUrls,
  toolbarColorScheme: 'dark',
} satisfies PhotoViewerProps;

await modalController.create({ component: PhotoViewerPage, componentProps });
```

#### Typed modal results

Dismiss payloads are now discriminated by `action`:

```typescript
// Editor — before
const { data } = await modal.onWillDismiss<IPhotoEditorDismiss>();
if (data?.value) {
  /* saved */
}

// Editor — after
const { data } = await modal.onWillDismiss<PhotoEditorResult>();
if (data?.action === 'save') {
  /* data.value */
}

// Viewer — before
const { data } = await modal.onWillDismiss<IPhotoViewerDismiss>();
if (data?.delete) {
  /* data.delete.index, data.delete.value */
}

// Viewer — after
const { data } = await modal.onWillDismiss<PhotoViewerResult>();
if (data?.action === 'delete') {
  /* data.index, data.value */
}
```

Removed types and replacements:

| Removed v21 export      | v22 replacement     |
| ----------------------- | ------------------- |
| `IPhotoEditorDismiss`   | `PhotoEditorResult` |
| `IPhotoViewerDismiss`   | `PhotoViewerResult` |
| `IDictionaryForEditor`  | `PhotoEditorLabels` |
| `IDictionaryForViewer`  | `PhotoViewerLabels` |
| `IDictionaryForService` | `PhotoFileLabels`   |
| `IFilter`               | `PhotoFilter`       |
| `IFilterPreset`         | `PhotoFilterPreset` |
| `ISize`                 | `PhotoSize`         |

#### PhotoFileService API

```typescript
// Before
photoFileService.photoMaxSize = 1000;
photoFileService.labels = { camera: '…', album: '…', cancel: '…' };
const files = await photoFileService.loadPhoto(2);

// After — register defaults once in ApplicationConfig.providers
export const appConfig = {
  providers: [
    providePhotoEditor({
      maxSize: 1000,
      labels: { camera: 'Camera', album: 'Album', cancel: 'Cancel' },
      createImageEditor: createTuiImageEditor,
      loadCamera: loadCapacitorPhotoCamera,
    }),
  ],
};

// Per call
const files = await photoFileService.loadPhoto({ limit: 2, maxSize: 1000, labels: { camera: 'Camera' } });
```

The global defaults and per-call overrides intentionally use the same `maxSize` and `labels` keys. Values passed to `loadPhoto()` take precedence for that request.

Cancellation and validation failures now throw `PhotoLoadError` with `code: 'cancelled' | 'invalid-type' | 'unavailable'` instead of returning empty arrays or generic errors.

Remove any static `<input id="browserPhotoUploader">` from `index.html`. On web, the service creates and removes a hidden file input synchronously when `loadPhoto()` runs; there is no fixed input id.

#### Accessibility and labels

- Pass `imageAlt` on the viewer for meaningful slide `alt` text (string or `(url, index) => string`).
- Override UI strings with `labels` on editor, viewer, and `loadPhoto({ labels })`. Built-in defaults remain Japanese (for example `保存`, `閉じる`, `削除`, `カメラ撮影`).

#### Update direct-template selectors

| Before               | After                   |
| -------------------- | ----------------------- |
| `<app-editor-image>` | `<rdlabo-photo-editor>` |
| `<app-photo-image>`  | `<rdlabo-photo-viewer>` |

No selector update is needed when presenting pages by component class through `ModalController`.

#### Stop using component internals

Component implementation members are no longer public API. This includes editor state and controllers such as `setLabels`, `modalCtrl`, `filters`, `footerMenu`, `currentCrop`, `currentRotate`, `photoCrop`, and `isCropped`, plus equivalent viewer internals such as `setLabels`, `swiper`, and swipe subscriptions. Use modal `componentProps`, `labels`, `imageAlt`, and the typed dismiss results instead of reading or mutating component instances.

#### Optional iOS 26 theme integration

Applications using `@rdlabo/ionic-theme-ios26` v3 can import the photo-editor adapter after the Ionic and iOS 26 theme styles:

```scss
@import '@rdlabo/ionic-theme-ios26/dist/css/ionic-theme-ios26.css';
@import '@ionic/angular/css/palettes/dark.class.css';
@import '@rdlabo/ionic-theme-ios26/dist/css/ionic-theme-ios26-dark-class.css';
@import '@rdlabo/ionic-angular-photo-editor/css/ios26-header-button-color-scheme.css';
```

Do not import the adapter when the application does not use the iOS 26 theme. See the photo editor [theme guide](../projects/photo-editor/docs/theme.md).

### @rdlabo/ionic-angular-kit

#### Remove kitAuthInput="autofill"

The `'autofill'` mode is removed. [WebKit bug 226023](https://bugs.webkit.org/show_bug.cgi?id=226023) (iOS autofill not propagating from `ion-input` to Angular forms) is fixed in the v22 minimum iOS/iPadOS 16.4 runtime, so the workaround is no longer shipped. Applications that must continue supporting an older iOS version cannot remove their app-local workaround and should remain on the v21 library line.

Remove both `kitAuthInput="autofill"` and the value-less `kitAuthInput` attribute from password and other non-email fields. In v21, a value-less attribute selected the default autofill mode; v22 has no default mode. Keep the directive only when email persistence is intended, and set it explicitly to `"email"` or `"email-remember"`.

```html
<!-- v21 password fields: remove either form entirely -->
<ion-input type="password" kitAuthInput />
<ion-input type="password" kitAuthInput="autofill" />
```

Email persistence modes are unchanged:

```html
<!-- sign-in: prefill + remember + forget on clear -->
<ion-input type="email" autocomplete="email" kitAuthInput="email" [formField]="form.email" />

<!-- sign-up: remember only -->
<ion-input type="email" autocomplete="email" kitAuthInput="email-remember" [formField]="form.email" />
```

`kitAuthInput` is now required on every use (no default). Other kit public APIs are unchanged after satisfying the compatibility requirements above.

### @rdlabo/ionic-angular-scroll-header

Version 22 has no package-specific API migration. Existing `rdlaboScrollHeader`, `rdlaboVirtualScrollHeader`, and `rdlaboFixVirtualScrollElement` usages remain valid after the dependency update.

### @rdlabo/ngx-cdk-scroll-strategies

#### Remove calcIndex

`calcIndex` is removed from the public API. Replace it with `calculateItemCountForPixelDistance`:

```typescript
// Before
import { calcIndex } from '@rdlabo/ngx-cdk-scroll-strategies';
const index = calcIndex(sizes, pixelOffset);

// After
import { calculateItemCountForPixelDistance } from '@rdlabo/ngx-cdk-scroll-strategies';
const index = calculateItemCountForPixelDistance(sizes, pixelOffset);
```

This is an intentional semantic correction, not a drop-in rename. The old function could undercount a partially consumed item: for sizes `[{ itemSize: 55 }, { itemSize: 55 }]` and distance `60`, it returned approximately `0.0909`; the replacement returns approximately `1.0909`. Revalidate thresholds, `startIndex`, and reverse-scroll behavior in every consumer rather than relying on the old numeric result.

#### Remove internal strategy factory export

`_dynamicSizeVirtualScrollStrategyFactory` and the public `_scrollStrategy` field on `CdkDynamicSizeVirtualScroll` are removed. They were internal wiring for the CDK `VIRTUAL_SCROLL_STRATEGY` token. Application code should inject `VIRTUAL_SCROLL_STRATEGY` or use `CdkDynamicSizeVirtualScroll.scrollOffset` instead of reaching into the directive.

Existing dynamic-size virtual-scroll template configuration remains valid.

### Verification

After applying the relevant package migrations, run the host application's normal checks and exercise the affected UI on each supported platform. For photo-editor, verify editor and viewer modals for every `toolbarColorScheme` the application uses, web photo picking without a static file input, and viewer `imageAlt` / label overrides where applicable.
