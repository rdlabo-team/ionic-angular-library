/** Filter options supported by the bundled photo editor presets. */
export type PhotoFilterOptions =
  | { blur: number }
  | { brightness: number }
  | { noise: number }
  | { blocksize: number }
  | { color: string; distance: number; useAlpha?: boolean }
  | { mode: string; color: string; alpha?: number }
  | { maskObjId: number }
  | null;

/** Rendered filter preview and the operation applied when it is selected. */
export interface PhotoFilter {
  name: string;
  type: string;
  option: PhotoFilterOptions;
  data: string;
  width: number;
  height: number;
}

/** Two-dimensional pixel size. */
export interface PhotoSize {
  width: number;
  height: number;
}

/** Localized labels rendered by {@link PhotoEditorPage}. */
export interface PhotoEditorLabels {
  save: string;
  close: string;
  back: string;
  apply: string;
  crop: string;
  rotate: string;
  cropCover: string;
  crop16x9: string;
  cropSquare: string;
  cropFree: string;
  filter: string;
  brightness: string;
  original: string;
  invert: string;
  sepia: string;
  vintage: string;
  blur: string;
  grayscale: string;
  sharpen: string;
  emboss: string;
}

/** A filter offered in the editor's preset menu. */
export interface PhotoFilterPreset {
  name: string;
  type: string;
  option: PhotoFilterOptions;
}

/** Successful result returned when the editor saves an image. */
export interface PhotoEditorResult {
  action: 'save';
  value: string;
}

/** Result returned when the viewer asks the consumer to delete an image. */
export interface PhotoViewerResult {
  action: 'delete';
  index: number;
  value: string;
}

/** Localized labels rendered by {@link PhotoViewerPage}. */
export interface PhotoViewerLabels {
  close: string;
  delete: string;
}

/** Localized labels used by the native photo source chooser. */
export interface PhotoFileLabels {
  camera: string;
  album: string;
  cancel: string;
}

/** Color scheme of the toolbar behind photo editor and viewer header buttons. */
export type PhotoToolbarColorScheme = 'light' | 'dark';

/** Props for presenting {@link PhotoViewerPage} via Ionic Modal `componentProps`. */
export interface PhotoViewerProps {
  imageUrls: string[];
  index?: number;
  isCircle?: boolean;
  enableDelete?: boolean;
  enableFooterSafeArea?: boolean;
  labels?: Partial<PhotoViewerLabels>;
  imageAlt?: string | ((url: string, index: number) => string);
  toolbarColorScheme: PhotoToolbarColorScheme;
}

/** Props for presenting {@link PhotoEditorPage} via Ionic Modal `componentProps`. */
export interface PhotoEditorProps {
  requireSquare?: boolean;
  value: string;
  labels?: Partial<PhotoEditorLabels>;
  toolbarColorScheme: PhotoToolbarColorScheme;
}

/** Per-request options for {@link PhotoFileService.loadPhoto}. */
export interface PhotoLoadOptions {
  limit?: number;
  maxSize?: number;
  labels?: Partial<PhotoFileLabels>;
}

/** Error codes produced by expected photo selection failures. */
export type PhotoLoadErrorCode = 'cancelled' | 'invalid-type' | 'unavailable';

/** Typed error produced by expected photo selection failures. */
export class PhotoLoadError extends Error {
  constructor(
    readonly code: PhotoLoadErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'PhotoLoadError';
  }
}
