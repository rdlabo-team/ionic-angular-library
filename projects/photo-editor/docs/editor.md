Present `PhotoEditorPage` in an Ionic modal. Call this after [Installation](../README.md#installation).

```typescript
import { PhotoEditorProps, PhotoEditorResult, providePhotoEditor } from '@rdlabo/ionic-angular-photo-editor';
import { PhotoEditorPage } from '@rdlabo/ionic-angular-photo-editor/editor';
import { createTuiImageEditor } from '@rdlabo/ionic-angular-photo-editor/editor/tui';

// app.config.ts
export const appConfig = {
  providers: [providePhotoEditor({ createImageEditor: createTuiImageEditor })],
};

(async () => {
  const componentProps = {
    requireSquare: false,
    value: 'https://picsum.photos/200/300',
    toolbarColorScheme: 'dark',
    labels: {
      save: '送信', // override default '保存'
    },
  } satisfies PhotoEditorProps;
  const modal = await this.modalCtrl.create({
    component: PhotoEditorPage,
    componentProps,
  });
  await modal.present();
  const { data } = await modal.onWillDismiss<PhotoEditorResult>();
  if (data?.action === 'save') {
    console.log(data.value);
  }
})();
```

## Modal result

On save, the modal dismisses with:

```typescript
interface PhotoEditorResult {
  action: 'save';
  value: string; // data URL of the edited image
}
```

Closing without saving dismisses with no data.

## Options

### requireSquare: boolean

When `true`, the image must be cropped to a square before editing continues.

### value: string

Image URL or data URL to edit.

### toolbarColorScheme: 'light' | 'dark'

**Required.** Use `dark` for a dark/black `ion-toolbar` and `light` for a light/white toolbar. The library cannot infer toolbar appearance from CSS, translucency, or runtime theme overrides. See [Theme](./theme.md).

### labels: Partial&lt;PhotoEditorLabels&gt;

Overrides default UI strings. Unspecified keys keep the built-in Japanese defaults:

| Key        | Default (ja)   |
| ---------- | -------------- |
| save       | 保存           |
| close      | 閉じる         |
| back       | 戻る           |
| apply      | 適用           |
| crop       | 切り抜き・回転 |
| rotate     | 回転           |
| cropCover  | 画像に合わせる |
| crop16x9   | 16対9          |
| cropSquare | 正方形         |
| cropFree   | 自由           |
| filter     | フィルター     |
| brightness | 明るさ         |
| original   | オリジナル     |
| invert     | 反転           |
| sepia      | セピア         |
| vintage    | ヴィンテージ   |
| blur       | ぼかし         |
| grayscale  | グレースケール |
| sharpen    | 輪郭           |
| emboss     | エンボス       |
