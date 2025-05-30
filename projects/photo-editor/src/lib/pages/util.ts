import { addIcons } from 'ionicons';
import {
  checkmarkOutline,
  closeOutline,
  colorFilterOutline,
  cropOutline,
  expandOutline,
  refreshOutline,
  removeOutline,
  send,
  squareOutline,
  sunnyOutline,
  tabletLandscapeOutline,
} from 'ionicons/icons';

export const initializeViewerIcons = (): void => {
  addIcons({
    closeOutline,
    removeOutline,
  });
};

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

export const waitToFindDom = (nativeElement: HTMLElement, selector: string): Promise<void> => {
  return new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const find = nativeElement.querySelector(selector);
      if (find) {
        clearInterval(interval);
        resolve();
      }
    });
  });
};
