import { PhotoViewerLabels } from '@rdlabo/ionic-angular-photo-editor';
import { IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonToolbar } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { closeOutline, removeOutline } from 'ionicons/icons';

export const ionComponents = [IonHeader, IonToolbar, IonButtons, IonButton, IonIcon, IonContent, IonFooter];

export const dictionaryForViewer = (): PhotoViewerLabels => ({
  close: '閉じる',
  delete: '削除',
});

export const initializeViewerIcons = (): void => {
  addIcons({ closeOutline, removeOutline });
};
