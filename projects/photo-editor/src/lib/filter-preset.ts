import { IDictionaryForEditor, IFilterPreset } from './types';

export const filterPreset = (dictionary: IDictionaryForEditor): IFilterPreset[] => [
  {
    name: dictionary.original,
    type: 'Default',
    option: null,
  },
  // {
  //   name: dictionary.invert,
  //   type: 'Invert',
  //   option: null,
  // },
  {
    name: dictionary.sepia,
    type: 'Sepia',
    option: null,
  },
  {
    name: dictionary.vintage,
    type: 'vintage',
    option: null,
  },
  {
    name: 'ぼかし',
    type: 'Blur',
    option: { blur: 0.1 },
  },
  {
    name: dictionary.grayscale,
    type: 'Grayscale',
    option: null,
  },
  // {
  //   name: dictionary.sharpen,
  //   type: 'Sharpen',
  //   option: null,
  // },
  // {
  //   name: dictionary.emboss,
  //   type: 'Emboss',
  //   option: null,
  // },
];
