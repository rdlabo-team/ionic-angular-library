Load photos from the camera or album. Call this after [Installation](../README.md#installation).

```typescript
import { providePhotoEditor, PhotoLoadError } from '@rdlabo/ionic-angular-photo-editor';
import { createTuiImageEditor } from '@rdlabo/ionic-angular-photo-editor/editor/tui';
import { PhotoFileService } from '@rdlabo/ionic-angular-photo-editor/file';
import { loadCapacitorPhotoCamera } from '@rdlabo/ionic-angular-photo-editor/file/capacitor';

// app.config.ts — optional global defaults
export const appConfig = {
  providers: [
    providePhotoEditor({
      maxPhotoSize: 1000,
      fileLabels: {
        camera: 'Camera',
        album: 'Album',
        cancel: 'Cancel',
      },
      createImageEditor: createTuiImageEditor,
      loadCamera: loadCapacitorPhotoCamera,
    }),
  ],
};

// component
export class AppComponent {
  private photoFileService = inject(PhotoFileService);

  async upload() {
    try {
      const files = await this.photoFileService.loadPhoto({
        limit: 1,
        maxSize: 1000,
        labels: { camera: 'Camera' }, // merges over configured defaults
      });
      if (files.length > 0) {
        // upload files
      }
    } catch (error) {
      if (error instanceof PhotoLoadError && error.code === 'cancelled') {
        return;
      }
      throw error;
    }
  }
}
```

## loadPhoto(options?)

Opens the platform photo picker and returns normalized data URLs.

| Option    | Default                             | Description                                    |
| --------- | ----------------------------------- | ---------------------------------------------- |
| `limit`   | `1`                                 | Maximum number of images (album and web only). |
| `maxSize` | configured `maxPhotoSize` or `1000` | Longest edge in pixels after resize.           |
| `labels`  | configured `fileLabels`             | Action sheet button text (Capacitor only).     |

### Browser behavior

On web, `loadPhoto()` synchronously creates a hidden `<input type="file">`, attaches it to `document.body`, and calls `click()` in the same turn as the caller's gesture. This preserves WebKit transient user activation. The input has no fixed id; it is removed after selection or cancellation.

Do not add a static file input to `index.html`.

### Capacitor behavior

On native platforms, an action sheet asks the user to choose camera or album. Per-request `labels` merge over values from `providePhotoEditor({ fileLabels })`.
Register `loadCapacitorPhotoCamera` from `/file/capacitor`; the base `/file` entry point stays usable by browser-only applications without `@capacitor/camera`.

### Errors

Expected failures throw `PhotoLoadError`:

| Code           | When                                                     |
| -------------- | -------------------------------------------------------- |
| `cancelled`    | User dismissed the picker or action sheet                |
| `invalid-type` | Selected file is not an image (web only)                 |
| `unavailable`  | Permission, plugin, picker, file-read, or resize failure |

## Default labels (ja)

When no `fileLabels` or per-request `labels` are supplied:

| Key    | Default (ja)     |
| ------ | ---------------- |
| camera | カメラ撮影       |
| album  | アルバムから選択 |
| cancel | キャンセル       |

## providePhotoEditor(config?)

Register application-wide defaults in `app.config.ts`:

```typescript
export const appConfig = {
  providers: [
    providePhotoEditor({
      maxPhotoSize: 1200,
      fileLabels: { camera: '…', album: '…', cancel: '…' },
      createImageEditor: createTuiImageEditor,
      loadCamera: loadCapacitorPhotoCamera, // omit in browser-only applications
    }),
  ],
};
```

`PhotoFileService` reads these adapters plus `maxPhotoSize` and `fileLabels` from this configuration. Per-request `maxSize` and `labels` override them for a single call. A resize requires `createImageEditor`; a native picker requires `loadCamera`. Missing adapters throw `PhotoLoadError` with `code: 'unavailable'`.
