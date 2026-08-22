# @rdlabo/ionic-angular-photo-editor

## Overview

Photo editor and viewer modal pages for Ionic Angular applications, with Capacitor camera/album support.

## Features

### Choose by editing goal

| Goal                              | Guide                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Load a photo from camera or album | [PhotoFileService](./docs/photo-file.md)                                                                                            |
| Crop and edit in a modal          | [Photo Editor](./docs/editor.md)                                                                                                    |
| Browse images in a modal          | [Photo Viewer](./docs/viewer.md)                                                                                                    |
| Override editor colors            | [Theme](./docs/theme.md)                                                                                                            |
| Upgrade from an earlier release   | [Migration guide](https://github.com/rdlabo-dev/ionic-angular-library/blob/main/docs/migration.md#rdlaboionic-angular-photo-editor) |

## Quick start

After [Installation](#installation), register optional defaults and load a photo:

```typescript
import { providePhotoEditor } from '@rdlabo/ionic-angular-photo-editor';
import { createTuiImageEditor } from '@rdlabo/ionic-angular-photo-editor/editor/tui';
import { PhotoFileService } from '@rdlabo/ionic-angular-photo-editor/file';
import { loadCapacitorPhotoCamera } from '@rdlabo/ionic-angular-photo-editor/file/capacitor';

// app.config.ts
export const appConfig = {
  providers: [
    providePhotoEditor({
      maxSize: 1000,
      createImageEditor: createTuiImageEditor,
      loadCamera: loadCapacitorPhotoCamera,
    }),
  ],
};

// component
const files = await this.photoFileService.loadPhoto({ limit: 1 });
```

Present the editor or viewer from their secondary entry points. Details: [PhotoFileService](./docs/photo-file.md), [Photo Editor](./docs/editor.md), [Photo Viewer](./docs/viewer.md).

## Package entry points

| Import path                                         | Exports                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `@rdlabo/ionic-angular-photo-editor`                | Types, `providePhotoEditor`, `PHOTO_EDITOR_CONFIG`, `PhotoLoadError` |
| `@rdlabo/ionic-angular-photo-editor/editor`         | `PhotoEditorPage`                                                    |
| `@rdlabo/ionic-angular-photo-editor/editor/tui`     | opt-in `createTuiImageEditor` adapter                                |
| `@rdlabo/ionic-angular-photo-editor/viewer`         | `PhotoViewerPage`                                                    |
| `@rdlabo/ionic-angular-photo-editor/file`           | `PhotoFileService`                                                   |
| `@rdlabo/ionic-angular-photo-editor/file/capacitor` | opt-in `loadCapacitorPhotoCamera` adapter                            |

Import components and services only from their entry point. Import shared types and configuration from the root package.

## Installation

```bash
npm install @rdlabo/ionic-angular-photo-editor
```

Install only the optional feature dependencies used by the application:

```bash
# editor, and resizing in PhotoFileService
npm install tui-image-editor

# viewer
npm install swiper

# native camera and album selection
npm install @capacitor/camera
```

Configure Android/iOS camera permissions as described in the [Capacitor Camera docs](https://capacitorjs.com/docs/apis/camera#android-configuration).
Native iOS applications must target iOS/iPadOS 16.4 or later.

No static `<input type="file">` in `index.html` is required. On web, `PhotoFileService` creates and attaches a hidden file input synchronously when `loadPhoto()` is called.
The root, `/editor`, and `/file` entry points do not import optional implementations. Opt in through `/editor/tui` and `/file/capacitor`; web-only consumers can omit the Capacitor adapter and dependency.

## Documentation

Start with [Installation](#installation), then pick a guide.

- [PhotoFileService](./docs/photo-file.md) — camera and album.
- [Photo Editor](./docs/editor.md) — crop and edit in a modal.
- [Photo Viewer](./docs/viewer.md) — browse images in a modal.
- [Theme](./docs/theme.md) — CSS variables and toolbar color scheme.
- [Migration guide](https://github.com/rdlabo-dev/ionic-angular-library/blob/main/docs/migration.md#rdlaboionic-angular-photo-editor) — breaking changes and required consumer updates.

<!-- rdlabo-docs-omit -->

**Full documentation:** [https://docs.rdlabo.dev/projects/ionic-angular-photo-editor](https://docs.rdlabo.dev/projects/ionic-angular-photo-editor)

<!-- /rdlabo-docs-omit -->
