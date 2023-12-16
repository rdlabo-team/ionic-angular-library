import { inject, Injectable, signal } from '@angular/core';
import { ActionSheetController, Platform } from '@ionic/angular/standalone';
import { Camera, CameraResultType, CameraSource, ImageOptions } from '@capacitor/camera';
import { GalleryPhotos } from '@capacitor/camera/dist/esm/definitions';
import ImageEditor from 'tui-image-editor';
import { PhotoEditorErrors } from '../photoEditorErrors';
import { dictionaryForService } from '../dictionaries';
import { IDictionaryForService } from '../types';

@Injectable({
  providedIn: 'root',
})
export class PhotoFileService {
  private readonly $photoMaxSize = signal<number>(1000);
  private readonly actionSheetCtrl = inject(ActionSheetController);
  private readonly platform = inject(Platform);
  private dictionary: IDictionaryForService = dictionaryForService();

  constructor() {}

  set photoMaxSize(value: number) {
    this.$photoMaxSize.set(value);
  }

  set labels(d: IDictionaryForService) {
    this.dictionary = Object.assign(this.dictionary, d);
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
          text: this.dictionary.camera,
          handler: () => {
            actionSheet.dismiss('camera');
          },
        },
        {
          text: this.dictionary.album,
          handler: () => {
            actionSheet.dismiss('album');
          },
        },
        {
          text: this.dictionary.cancel,
          role: 'cancel',
        },
      ],
    });
    await actionSheet.present();
    const { data } = await actionSheet.onDidDismiss<'camera' | 'album'>();
    if (!data) {
      return Promise.reject(PhotoEditorErrors.cancel);
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
        return Promise.reject(PhotoEditorErrors.cancel);
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
      }).catch(() => undefined);

      if (!images) {
        return Promise.reject(PhotoEditorErrors.cancel);
      }

      return Promise.all(images.photos.map(async (image) => await this.loadPhotoFromFilePath(image.webPath)));
    }

    // Not run on this line. This is for lint
    return [];
  }

  private getPictureFromBrowser(): Promise<string[]> {
    const inputFile: HTMLInputElement | null = document.querySelector('input#browserPhotoUploader');

    if (!inputFile) {
      return Promise.reject(PhotoEditorErrors.initialize);
    }

    return new Promise((resolve, reject) => {
      inputFile!.addEventListener(
        'change',
        (e: Event) => {
          if (!(e.target as HTMLInputElement).files || !(e.target as HTMLInputElement).files![0]) {
            reject(PhotoEditorErrors.cancel);
          }
          const file = (e.target as HTMLInputElement).files![0];
          const reader = new FileReader();

          reader.onload = (() => {
            if (file.type.indexOf('image') < 0) {
              reject(PhotoEditorErrors.type);
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
