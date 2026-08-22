Present `PhotoEditorPage` in an Ionic modal. Call this after [Installation](../README.md#installation).

```typescript
import { PhotoEditorPage, IPhotoEditorDismiss, PhotoEditorProps } from '@rdlabo/ionic-angular-photo-editor';

(async () => {
  const componentProps = {
    requireSquare: false,
    value: 'https://picsum.photos/200/300',
    headerButtonColorScheme: 'dark',
    labels: {
      save: '送信', // change '保存' to '送信'
    },
  } satisfies PhotoEditorProps;
  const modal = await this.modalCtrl.create({
    component: PhotoEditorPage,
    componentProps,
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

List is [here](https://github.com/rdlabo-dev/ionic-angular-library/blob/v21.6.2/projects/photo-editor/src/lib/dictionaries.ts).

#### headerButtonColorScheme: 'light' | 'dark'

Required. Select `dark` for a dark/black `ion-toolbar` and `light` for a light/white toolbar. The library cannot infer the toolbar appearance from CSS, translucent content, or runtime theme overrides.
