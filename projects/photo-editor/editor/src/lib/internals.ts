import { PhotoEditorLabels } from '@rdlabo/ionic-angular-photo-editor';
import { addIcons } from 'ionicons';
import {
  checkmarkOutline,
  closeOutline,
  colorFilterOutline,
  cropOutline,
  expandOutline,
  refreshOutline,
  send,
  squareOutline,
  sunnyOutline,
  tabletLandscapeOutline,
} from 'ionicons/icons';

export const dictionaryForEditor = (): PhotoEditorLabels => ({
  save: '保存',
  close: '閉じる',
  back: '戻る',
  apply: '適用',
  crop: '切り抜き・回転',
  rotate: '回転',
  cropCover: '画像に合わせる',
  crop16x9: '16対9',
  cropSquare: '正方形',
  cropFree: '自由',
  filter: 'フィルター',
  brightness: '明るさ',
  original: 'オリジナル',
  invert: '反転',
  sepia: 'セピア',
  vintage: 'ヴィンテージ',
  blur: 'ぼかし',
  grayscale: 'グレースケール',
  sharpen: '輪郭',
  emboss: 'エンボス',
});

export const initializeEditorIcons = (): void => {
  addIcons({
    closeOutline,
    send,
    cropOutline,
    colorFilterOutline,
    sunnyOutline,
    expandOutline,
    tabletLandscapeOutline,
    squareOutline,
    refreshOutline,
    checkmarkOutline,
  });
};
