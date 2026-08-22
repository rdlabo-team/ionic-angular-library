# @rdlabo/ionic-angular-photo-editor

## Overview

This is a photo editor and viewer for modal page of Ionic Angular project using Capacitor.

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

After [Installation](#installation), load a photo:

```typescript
import { PhotoFileService } from '@rdlabo/ionic-angular-photo-editor';

const files = await this.photoFileService.loadPhoto(1);
```

Then present the editor or viewer. Details: [PhotoFileService](./docs/photo-file.md), [Photo Editor](./docs/editor.md), [Photo Viewer](./docs/viewer.md).

## Installation

```bash
npm install @rdlabo/ionic-angular-photo-editor
```

If you use capacitor, you need to install plugin:

```bash
npm install @capacitor/camera swiper tui-image-editor
```

And set permission. more info is here: [Camera](https://capacitorjs.com/docs/apis/camera#android-configuration)

If you public your project to the web, you need to add the following input tag to the index.html.

```html
<div style="width: 0; height: 0; overflow: hidden">
  <input id="browserPhotoUploader" type="file" accept="image/*" />
</div>
```

## Documentation

Start with [Installation](#installation), then pick a guide.

- [PhotoFileService](./docs/photo-file.md) — camera and album.
- [Photo Editor](./docs/editor.md) — crop and edit in a modal.
- [Photo Viewer](./docs/viewer.md) — browse images in a modal.
- [Theme](./docs/theme.md) — CSS variables.
- [Migration guide](https://github.com/rdlabo-dev/ionic-angular-library/blob/main/docs/migration.md#rdlaboionic-angular-photo-editor) — breaking changes and required consumer updates.

<!-- rdlabo-docs-omit -->

**Full documentation:** [https://docs.rdlabo.dev/projects/ionic-angular-photo-editor](https://docs.rdlabo.dev/projects/ionic-angular-photo-editor)

<!-- /rdlabo-docs-omit -->
