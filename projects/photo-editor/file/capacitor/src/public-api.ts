import { PhotoCameraLoader } from '@rdlabo/ionic-angular-photo-editor';

/** Loads the Capacitor Camera implementation in a bundler-resolvable lazy chunk. */
export const loadCapacitorPhotoCamera: PhotoCameraLoader = async () => {
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
  return {
    getPhoto: async (options) => {
      const image = await Camera.getPhoto({
        quality: options.quality,
        width: options.width,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        presentationStyle: 'popover',
      });
      return { dataUrl: image.dataUrl, webPath: image.webPath };
    },
    pickImages: (options) =>
      Camera.pickImages({
        quality: options.quality,
        width: options.width,
        limit: options.limit,
        presentationStyle: 'popover',
      }),
  };
};
