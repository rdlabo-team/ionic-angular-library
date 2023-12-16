import { Injectable } from '@angular/core';
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
  removeOutline,
} from 'ionicons/icons';

@Injectable()
export class HelperService {
  constructor() {}

  initializeViewerIcons(): void {
    addIcons({
      closeOutline,
      removeOutline,
    });
  }

  initializeEditorIcons(): void {
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
  }

  waitToFindDom(nativeElement: HTMLElement, selector: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const find = nativeElement.querySelector(selector);
        if (find) {
          clearInterval(interval);
          resolve();
        }
      });
    });
  }
}
