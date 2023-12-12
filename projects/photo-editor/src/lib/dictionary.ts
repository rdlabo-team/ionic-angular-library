import { IDictionary } from './types';

export const dictionary = (): IDictionary => ({
  // UI labels
  save: '保存',
  crop: '切り抜き・回転',
  filter: 'フィルター',
  brightness: '明るさ',

  // Filter labels
  original: 'オリジナル',
  invert: '反転',
  sepia: 'セピア',
  vintage: 'ヴィンテージ',
  blur: 'ぼかし',
  grayscale: 'グレースケール',
  sharpen: '輪郭',
  emboss: 'エンボス',
});
