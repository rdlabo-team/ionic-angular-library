These libraries is a collection of components and services that are useful for developing Ionic Angular applications.

[Demo site is here.](https://rdlabo-ionic-angular-library.netlify.app/)

# @rdlabo/ionic-angular-photo-editor

This is a photo editor and viewer for modal page of Ionic Angular project using Capacitor.

## Installation

```bash
npm install @rdlabo/ionic-angular-photo-editor
```

If you use capacitor, you need to install plugin:

```bash
npm install @capacitor/camera
```

And set permission. more info is here: [Camera](https://capacitorjs.com/docs/apis/camera#android-configuration)

If you public your project to the web, you need to add the following input tag to the index.html.

```html
<div style="width: 0; height: 0; overflow: hidden">
  <input id="browserPhotoUploader" type="file" accept="image/*" />
</div>
```

## Usage

### PhotoFileService

```typescript
import { PhotoFileService } from '@rdlabo/ionic-angular-photo-editor';

export class AppComponent {
  private photoFileService = inject(PhotoFileService);

  constructor() {
    this.photoFileService.photoMaxSize = 1000;
    this.photoFileService.labels = {
      camera: 'Camera',
      album: 'Album',
      cancel: 'Cancel',
    };
  }
  
  async upload() {
    const file = await this.photoFileService.loadPhoto();
    if (file) {
      // upload file
    }
  }
}
````

#### Options
##### photoMaxSize

The maximum size of the photo. Default is 1000.

##### labels

If set, the label is overwritten.


### PhotoEditorPage

```typescript
import { PhotoEditorPage, IPhotoEditorDismiss } from '@rdlabo/ionic-angular-photo-editor';

(async () => {
  const modal = await this.modalCtrl.create({
    component: PhotoEditorPage,
    componentProps: {
      requireSquare: false,
      value: 'https://picsum.photos/200/300',
      label: {
        save: '送信', // change '保存' to '送信'
      },
    },
  });
  await modal.present();
  const { data } = await modal.onWillDismiss<IPhotoEditorDismiss>();
  if (data?.value) {
    console.log(data.value);
  }
})();
```

### Options

#### requireSquare: boolean

If true, the image must be cropped to a square at first.

#### value: string

The image url or base64 string.

#### labels: IDictionaryForEditor

If set, the label is overwritten.

List is [here](https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/photo-editor/src/lib/dictionaries.ts).


### PhotoViewerPage

```typescript
import { PhotoViewerPage, IPhotoViewerDismiss } from '@rdlabo/ionic-angular-photo-editor';

(async () => {
  const modal = await this.modalCtrl.create({
    component: PhotoViewerPage,
    componentProps: {
      imageUrls: [
        'https://picsum.photos/200/300',
        'https://picsum.photos/200/300',
      ],
      index: 0,
      isCircle: false,
    },
  });
  await modal.present();
  const { data } = await modal.onWillDismiss<IPhotoViewerDismiss>();
  if (data?.delete) {
    // User delete image
  }
})();
```

### Options

#### imageUrls: string[]

The image url or base64 string[].

#### index: number

The index of imageUrls.

#### isCircle: boolean

If set, the image is displayed in a circle.

#### enableDelete: boolean

If true, the delete button is displayed.

#### enableFooterSafeArea: boolean

If true, enable footer safe area for iOS.

#### labels: IDictionaryForViewer

If set, the label is overwritten.

List is [here](https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/photo-editor/src/lib/dictionaries.ts).
