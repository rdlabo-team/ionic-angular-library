export interface IFilter {
  name: string;
  type: string;
  option: any;
  data: string;
  width: number;
  height: number;
}

export interface ISize {
  width: number;
  height: number;
}

export interface IDictionaryForEditor {
  save: string;
  crop: string;
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

export interface IFilterPreset {
  name: string;
  type: string;
  option: any;
}

export interface IPhotoEditorDismiss {
  value: string;
}

export interface IPhotoViewerDismiss {
  delete: {
    index: number;
    value: string;
  };
}

export interface IDictionaryForViewer {
  delete: string;
}

export interface IDictionaryForService {
  camera: string;
  album: string;
  cancel: string;
}

/** Props for presenting {@link PhotoViewerPage} via Ionic Modal `componentProps`. */
export interface PhotoViewerProps {
  imageUrls?: string[];
  index?: number;
  isCircle?: boolean;
  enableDelete?: boolean;
  enableFooterSafeArea?: boolean;
  labels?: Partial<IDictionaryForViewer>;
}

/** Props for presenting {@link PhotoEditorPage} via Ionic Modal `componentProps`. */
export interface PhotoEditorProps {
  requireSquare?: boolean;
  value: string;
  labels?: Partial<IDictionaryForEditor>;
}
