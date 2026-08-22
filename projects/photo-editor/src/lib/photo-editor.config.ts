import { EnvironmentProviders, InjectionToken, makeEnvironmentProviders } from '@angular/core';
import { dictionaryForService } from './dictionaries';
import { PhotoFileLabels, PhotoFilterOptions, PhotoLoadError } from './types';

/** Canvas bounds passed to the underlying image editor implementation. */
export interface PhotoImageEditorOptions {
  cssMaxWidth: number;
  cssMaxHeight: number;
}

/** Rectangle returned by the editor crop tool. */
export interface PhotoCropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Minimal image-editor contract required by the library entry points. */
export interface PhotoImageEditor {
  applyFilter(type: string, options?: Exclude<PhotoFilterOptions, null>): Promise<unknown>;
  crop(rect: PhotoCropRect): Promise<unknown>;
  destroy(): void;
  getCropzoneRect(): PhotoCropRect;
  hasFilter(type: string): boolean;
  loadImageFromFile(file: File): Promise<{ newWidth: number; newHeight: number }>;
  removeFilter(type: string): Promise<unknown>;
  rotate(angle: number): Promise<unknown>;
  setCropzoneRect(ratio?: number): void;
  startDrawingMode(mode: string): void;
  stopDrawingMode(): void;
  toDataURL(options?: { multiplier?: number }): string;
}

/** Lazily creates the image editor used for editing and resizing. */
export type PhotoImageEditorFactory = (host: Element, options: PhotoImageEditorOptions) => Promise<PhotoImageEditor>;

/** Options passed to a native camera adapter. */
export interface PhotoCameraOptions {
  quality: number;
  width: number;
  limit?: number;
  source?: 'camera';
}

/** Image metadata returned by a native camera adapter. */
export interface PhotoCameraImage {
  dataUrl?: string;
  webPath?: string;
}

/** Minimal native camera contract required by {@link PhotoFileService}. */
export interface PhotoCameraAdapter {
  getPhoto(options: PhotoCameraOptions): Promise<PhotoCameraImage>;
  pickImages(options: PhotoCameraOptions): Promise<{ photos: PhotoCameraImage[] }>;
}

/** Lazily creates the native camera adapter used on Capacitor platforms. */
export type PhotoCameraLoader = () => Promise<PhotoCameraAdapter>;

/** Global defaults for photo selection and image editor construction. */
export interface PhotoEditorConfig {
  maxSize?: number;
  labels?: Partial<PhotoFileLabels>;
  createImageEditor?: PhotoImageEditorFactory;
  loadCamera?: PhotoCameraLoader;
}

interface ResolvedPhotoEditorConfig {
  maxSize: number;
  labels: PhotoFileLabels;
  createImageEditor: PhotoImageEditorFactory;
  loadCamera: PhotoCameraLoader;
}

const missingImageEditor: PhotoImageEditorFactory = () =>
  Promise.reject(new PhotoLoadError('unavailable', { cause: new Error('Configure createImageEditor with the editor adapter.') }));
const missingCamera: PhotoCameraLoader = () =>
  Promise.reject(new PhotoLoadError('unavailable', { cause: new Error('Configure loadCamera with the Capacitor adapter.') }));

/** Resolved photo editor configuration used by library services and components. */
export const PHOTO_EDITOR_CONFIG = new InjectionToken<ResolvedPhotoEditorConfig>('PHOTO_EDITOR_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    maxSize: 1000,
    labels: dictionaryForService(),
    createImageEditor: missingImageEditor,
    loadCamera: missingCamera,
  }),
});

/** Provides application-wide photo editor defaults and an optional editor adapter. */
export function providePhotoEditor(config: PhotoEditorConfig = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: PHOTO_EDITOR_CONFIG,
      useValue: {
        maxSize: config.maxSize ?? 1000,
        labels: { ...dictionaryForService(), ...config.labels },
        createImageEditor: config.createImageEditor ?? missingImageEditor,
        loadCamera: config.loadCamera ?? missingCamera,
      } satisfies ResolvedPhotoEditorConfig,
    },
  ]);
}
