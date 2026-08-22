import { PhotoEditorLabels, PhotoFilterPreset } from '@rdlabo/ionic-angular-photo-editor';

export const filterPreset = (dictionary: PhotoEditorLabels): PhotoFilterPreset[] => [
  { name: dictionary.original, type: 'Default', option: null },
  { name: dictionary.sepia, type: 'Sepia', option: null },
  { name: dictionary.vintage, type: 'vintage', option: null },
  { name: dictionary.blur, type: 'Blur', option: { blur: 0.1 } },
  { name: dictionary.grayscale, type: 'Grayscale', option: null },
];
