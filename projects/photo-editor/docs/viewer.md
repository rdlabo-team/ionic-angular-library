Present `PhotoViewerPage` in an Ionic modal. Call this after [Installation](../README.md#installation).

```typescript
import { PhotoViewerPage, IPhotoViewerDismiss } from '@rdlabo/ionic-angular-photo-editor';

(async () => {
  const modal = await this.modalCtrl.create({
    component: PhotoViewerPage,
    componentProps: {
      imageUrls: ['https://picsum.photos/200/300', 'https://picsum.photos/200/300'],
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

List is [here](https://github.com/rdlabo-dev/ionic-angular-library/blob/v21.6.2/projects/photo-editor/src/lib/dictionaries.ts).
