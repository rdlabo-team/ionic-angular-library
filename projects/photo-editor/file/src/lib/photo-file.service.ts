import { inject, Injectable } from '@angular/core';
import { ActionSheetController, Platform } from '@ionic/angular';
import {
  PHOTO_EDITOR_CONFIG,
  PhotoFileLabels,
  PhotoImageEditorFactory,
  PhotoLoadError,
  PhotoLoadOptions,
} from '@rdlabo/ionic-angular-photo-editor';

/** Selects and normalizes photos from browser and Capacitor sources. */
@Injectable({
  providedIn: 'root',
})
export class PhotoFileService {
  readonly #actionSheetCtrl = inject(ActionSheetController);
  readonly #platform = inject(Platform);
  readonly #config = inject(PHOTO_EDITOR_CONFIG);

  /** Opens the platform photo picker and returns normalized data URLs. */
  async loadPhoto(options: PhotoLoadOptions = {}): Promise<string[]> {
    const limit = Math.max(1, Math.trunc(options.limit ?? 1));
    const maxSize = Math.max(1, Math.trunc(options.maxSize ?? this.#config.maxPhotoSize));
    const labels = { ...this.#config.fileLabels, ...options.labels } satisfies PhotoFileLabels;

    if (!this.#platform.is('capacitor')) {
      return this.#getPictureFromBrowser(limit, maxSize);
    }

    const source = await this.#chooseNativeSource(labels);
    if (source === 'camera') {
      return this.#getPictureFromCamera(maxSize);
    }
    return this.#getPicturesFromAlbum(limit, maxSize);
  }

  async #chooseNativeSource(labels: PhotoFileLabels): Promise<'camera' | 'album'> {
    const actionSheet = await this.#actionSheetCtrl.create({
      buttons: [
        {
          text: labels.camera,
          handler: () => {
            void actionSheet.dismiss('camera');
          },
        },
        {
          text: labels.album,
          handler: () => {
            void actionSheet.dismiss('album');
          },
        },
        {
          text: labels.cancel,
          role: 'cancel',
        },
      ],
    });
    await actionSheet.present();
    const { data } = await actionSheet.onDidDismiss<'camera' | 'album'>();
    if (!data) {
      throw new PhotoLoadError('cancelled');
    }
    return data;
  }

  async #getPictureFromCamera(maxSize: number): Promise<string[]> {
    const camera = await this.#config.loadCamera();
    const image = await camera
      .getPhoto({
        quality: 100,
        width: maxSize,
        source: 'camera',
      })
      .catch((error: unknown) => {
        throw this.#nativePickerError(error);
      });
    if (!image?.dataUrl) {
      throw new PhotoLoadError('unavailable');
    }
    if (!image.dataUrl.includes('capacitor://localhost')) {
      return [image.dataUrl];
    }
    return [await this.#loadPhotoFromFilePath(image.dataUrl, maxSize)];
  }

  async #getPicturesFromAlbum(limit: number, maxSize: number): Promise<string[]> {
    const camera = await this.#config.loadCamera();
    const images = await camera.pickImages({ quality: 100, width: maxSize, limit }).catch((error: unknown) => {
      throw this.#nativePickerError(error);
    });
    return Promise.all(
      images.photos.slice(0, limit).map(({ webPath }) => {
        if (!webPath) {
          throw new PhotoLoadError('unavailable');
        }
        return this.#loadPhotoFromFilePath(webPath, maxSize);
      }),
    );
  }

  #getPictureFromBrowser(limit: number, maxSize: number): Promise<string[]> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = limit > 1;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.style.position = 'fixed';
    input.style.inset = '0 auto auto -10000px';
    document.body.append(input);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        input.removeEventListener('cancel', cancel);
        input.removeEventListener('change', change);
        input.remove();
      };
      const cancel = () => {
        cleanup();
        reject(new PhotoLoadError('cancelled'));
      };
      const change = () => {
        const files = Array.from(input.files ?? []).slice(0, limit);
        input.value = '';
        cleanup();
        if (files.length === 0) {
          reject(new PhotoLoadError('cancelled'));
          return;
        }
        if (files.some(({ type }) => !type.startsWith('image/'))) {
          reject(new PhotoLoadError('invalid-type'));
          return;
        }
        void Promise.all(files.map((file) => this.#readBrowserFile(file, maxSize))).then(resolve, reject);
      };

      input.addEventListener('cancel', cancel);
      input.addEventListener('change', change);
      // Keep this synchronous with the caller's click/tap so WebKit retains transient user activation.
      try {
        input.click();
      } catch (error) {
        cleanup();
        reject(new PhotoLoadError('unavailable', { cause: error }));
      }
    });
  }

  #readBrowserFile(file: File, maxSize: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = event.target?.result;
        if (typeof result !== 'string') {
          reject(new PhotoLoadError('unavailable'));
          return;
        }
        void this.#loadPhotoFromFilePath(result, maxSize).then(resolve, reject);
      };
      reader.onerror = () => reject(new PhotoLoadError('unavailable', { cause: reader.error }));
      reader.onabort = () => reject(new PhotoLoadError('cancelled'));
      reader.readAsDataURL(file);
    });
  }

  async #loadPhotoFromFilePath(filePath: string, maxPhotoSize: number): Promise<string> {
    const editor = await this.#config.createImageEditor(document.createElement('div'), {
      cssMaxWidth: maxPhotoSize,
      cssMaxHeight: maxPhotoSize,
    });
    return this.#resizePhoto(editor, filePath, maxPhotoSize)
      .catch((error: unknown) => {
        throw error instanceof PhotoLoadError ? error : new PhotoLoadError('unavailable', { cause: error });
      })
      .finally(() => editor.destroy());
  }

  #nativePickerError(error: unknown): PhotoLoadError {
    if (error instanceof PhotoLoadError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new PhotoLoadError(/cancelled|canceled/i.test(message) ? 'cancelled' : 'unavailable', { cause: error });
  }

  async #resizePhoto(editor: Awaited<ReturnType<PhotoImageEditorFactory>>, filePath: string, maxPhotoSize: number): Promise<string> {
    const response = await fetch(filePath);
    if (!response.ok) {
      throw new Error(`Unable to load photo: ${response.status}`);
    }
    const blob = await response.blob();
    const loaded = await editor.loadImageFromFile(new File([blob], 'data.png', { type: blob.type }));
    const longestEdge = Math.max(loaded.newWidth, loaded.newHeight);
    return editor.toDataURL({
      multiplier: longestEdge > 0 ? Math.min(1, maxPhotoSize / longestEdge) : 1,
    });
  }
}
