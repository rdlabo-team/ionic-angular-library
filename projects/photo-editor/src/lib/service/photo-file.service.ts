import { inject, Injectable, signal } from '@angular/core';
import { ActionSheetController, Platform } from '@ionic/angular/standalone';
import { Camera, CameraResultType, CameraSource, ImageOptions } from '@capacitor/camera';
import { GalleryPhotos } from '@capacitor/camera/dist/esm/definitions';
import ImageEditor from 'tui-image-editor';

@Injectable({
  providedIn: 'root',
})
export class PhotoFileService {
  private readonly $photoMaxSize = signal<number>(1000);
  private readonly actionSheetCtrl = inject(ActionSheetController);
  private readonly platform = inject(Platform);

  constructor() {}

  set photoMaxSize(value: number) {
    this.$photoMaxSize.set(value);
  }

  async loadPhoto(limit: number): Promise<string[]> {
    /**
     * Using Input for browser
     */
    if (!this.platform.is('capacitor')) {
      return this.getPictureFromBrowser();
    }

    const actionSheet = await this.actionSheetCtrl.create({
      buttons: [
        {
          text: 'カメラ撮影',
          handler: () => {
            actionSheet.dismiss('camera');
          },
        },
        {
          text: 'アルバムから選択',
          handler: () => {
            actionSheet.dismiss('album');
          },
        },
        {
          text: 'キャンセル',
          role: 'cancel',
        },
      ],
    });
    await actionSheet.present();
    const { data } = await actionSheet.onDidDismiss<'camera' | 'album'>();
    if (!data) {
      return [];
    }

    if (data === 'camera') {
      const defaultCamera: ImageOptions = {
        quality: 100,
        width: this.$photoMaxSize(),
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        presentationStyle: 'popover',
      };
      const image = await Camera.getPhoto(defaultCamera).catch(() => undefined);

      if (!image?.dataUrl) {
        return [];
      }
      if (!image.dataUrl.includes('capacitor://localhost')) {
        return [image.dataUrl];
      }
      return Promise.all([image.dataUrl].map(async (image) => await this.loadPhotoFromFilePath(image)));
    }

    if (data === 'album') {
      const images = await Camera.pickImages({
        quality: 100,
        width: this.$photoMaxSize(),
        limit,
        presentationStyle: 'popover',
      }).catch(
        () =>
          ({
            photos: [],
          }) as GalleryPhotos,
      );

      return Promise.all(images.photos.map(async (image) => await this.loadPhotoFromFilePath(image.webPath)));
    }

    return [];
  }

  private getPictureFromBrowser(): Promise<string[]> {
    const inputFile: HTMLInputElement | null = document.querySelector('input#browserPhotoUploader');

    if (!inputFile) {
      return Promise.reject('[error] Input DOM is not found.');
    }

    return new Promise((resolve, reject) => {
      inputFile!.addEventListener(
        'change',
        (e: Event) => {
          if (!(e.target as HTMLInputElement).files || !(e.target as HTMLInputElement).files![0]) {
            reject('[error] File is not selected.');
          }
          const file = (e.target as HTMLInputElement).files![0];
          const reader = new FileReader();

          reader.onload = (() => {
            if (file.type.indexOf('image') < 0) {
              reject('[error] Upload file is not image.');
            }

            return async (event) => {
              inputFile.value = '';
              const result = event.target!.result as string;
              const data = await this.loadPhotoFromFilePath(result);
              resolve([data]);
            };
          })();

          reader.readAsDataURL(file);
        },
        false,
      );
      inputFile.click();
    });
  }

  private async loadPhotoFromFilePath(filePath: string): Promise<string> {
    const defaultInstance = new ImageEditor(document.createElement('div'), {
      cssMaxWidth: this.$photoMaxSize(),
      cssMaxHeight: this.$photoMaxSize(),
    });
    const blob = await fetch(filePath).then((res) => res.blob());
    const loaded = await defaultInstance.loadImageFromFile(new File([blob], 'data.png', { type: blob.type }));

    const maxSize = Math.max(loaded.newWidth, loaded.newHeight);
    const dataUrl = defaultInstance.toDataURL({
      multiplier: this.$photoMaxSize() / maxSize,
    });
    defaultInstance.destroy();

    return dataUrl;
  }
}
