import { IDictionaryForEditor, IDictionaryForViewer } from './types';

export const dictionaryForEditor = (): IDictionaryForEditor => ({
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

export const dictionaryForViewer = (): IDictionaryForViewer => ({
  // UI labels
  delete: '削除',
});
