Present `PhotoViewerPage` in an Ionic modal. Call this after [Installation](../README.md#installation).

```typescript
import { PhotoViewerProps, PhotoViewerResult } from '@rdlabo/ionic-angular-photo-editor';
import { PhotoViewerPage } from '@rdlabo/ionic-angular-photo-editor/viewer';

(async () => {
  const componentProps = {
    imageUrls: ['https://picsum.photos/200/300', 'https://picsum.photos/200/301'],
    index: 0,
    isCircle: false,
    enableDelete: true,
    toolbarColorScheme: 'dark',
    imageAlt: (url, index) => `Photo ${index + 1}`,
    labels: {
      delete: 'Delete',
    },
  } satisfies PhotoViewerProps;
  const modal = await this.modalCtrl.create({
    component: PhotoViewerPage,
    componentProps,
  });
  await modal.present();
  const { data } = await modal.onWillDismiss<PhotoViewerResult>();
  if (data?.action === 'delete') {
    console.log(data.index, data.value);
  }
})();
```

## Modal result

When the user taps delete, the modal dismisses with:

```typescript
interface PhotoViewerResult {
  action: 'delete';
  index: number;
  value: string; // URL of the image at index
}
```

Closing or swiping down dismisses with no data.

## Options

### imageUrls: string[]

**Required.** Image URLs or data URLs to display.

### index: number

Initial slide index. Default `0`.

### isCircle: boolean

When `true`, images render in a circle.

### enableDelete: boolean

When `true`, shows the delete button.

### enableFooterSafeArea: boolean

When `true`, adds footer safe-area padding on iOS.

### toolbarColorScheme: 'light' | 'dark'

**Required.** Use `dark` for a dark/black `ion-toolbar` and `light` for a light/white toolbar. See [Theme](./theme.md).

### imageAlt: string | ((url: string, index: number) => string)

Accessible `alt` text for each slide image. Default is an empty string. Pass a function when alt text depends on the URL or index.

### labels: Partial&lt;PhotoViewerLabels&gt;

Overrides default UI strings. Unspecified keys keep the built-in Japanese defaults:

| Key    | Default (ja) |
| ------ | ------------ |
| close  | 閉じる       |
| delete | 削除         |

The close button also uses `aria-label` from the `close` label.
