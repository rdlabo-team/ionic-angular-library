Load photos from the camera or album. Call this after [Installation](../README.md#installation).

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
    const files = await this.photoFileService.loadPhoto(1);
    if (files.length > 0) {
      // upload files
    }
  }
}
```

#### Options

##### photoMaxSize

The maximum size of the photo. Default is 1000.

##### labels

If set, the label is overwritten.
