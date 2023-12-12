These libraries is a collection of components and services that are useful for developing Ionic Angular applications.

[Demo site is here.](https://rdlabo-ionic-angular-library.netlify.app/)

## @rdlabo/ionic-angular-photo-editor

This is a photo editor page for modal page of Ionic Angular project.

### Installation

```bash
npm install @rdlabo/ionic-angular-photo-editor
```

### Usage

```typescript
import { PhotoEditorPage } from '@rdlabo/ionic-angular-photo-editor';

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

#### requireSquare

If true, the image must be cropped to a square at first.

#### value

The image url or base64 string.

#### label

If set, the label is overwritten.

List is [here](https://github.com/rdlabo-team/ionic-angular-library/blob/main/projects/photo-editor/src/lib/dictionary.ts).
