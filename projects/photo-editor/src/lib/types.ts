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
