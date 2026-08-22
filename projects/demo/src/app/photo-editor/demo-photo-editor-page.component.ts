import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonApp,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonItemGroup,
  IonLabel,
  IonList,
  IonListHeader,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { PhotoEditorProps, PhotoEditorResult, PhotoViewerProps, PhotoViewerResult } from 'photo-editor';
import { PhotoEditorPage } from 'photo-editor/editor';
import { PhotoFileService } from 'photo-editor/file';
import { PhotoViewerPage } from 'photo-editor/viewer';

@Component({
  selector: 'app-photo-editor',
  templateUrl: './demo-photo-editor-page.component.html',
  styleUrls: ['./demo-photo-editor-page.component.scss'],
  imports: [
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    CommonModule,
    FormsModule,
    IonApp,
    IonButton,
    IonButtons,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    IonItemGroup,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DemoPhotoEditorPage {
  private readonly photoFileService = inject(PhotoFileService);
  private readonly modalCtrl = inject(ModalController);

  async selectPhoto(type: 'editor' | 'viewer') {
    const labels = { camera: 'Camera', album: 'Album', cancel: 'Cancel' };
    if (type === 'editor') {
      const data = await this.photoFileService.loadPhoto({ limit: 1, maxSize: 1000, labels });
      await this.launchEditor(data[0]);
    } else {
      const data = await this.photoFileService.loadPhoto({ limit: 2, maxSize: 1000, labels });
      await this.launchViewer(data);
    }
  }

  async launchEditor(
    photoData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2kF7WQAAAABJRU5ErkJggg==',
  ) {
    const modal = await this.modalCtrl.create({
      component: PhotoEditorPage,
      componentProps: {
        requireSquare: false,
        value: photoData,
        toolbarColorScheme: 'dark',
      } satisfies PhotoEditorProps,
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<PhotoEditorResult>();
    if (data?.action === 'save') {
      console.log(data.value);
    }
  }

  async launchViewer(photoData: string[] = ['https://picsum.photos/200/300', 'https://picsum.photos/200/300']) {
    const modal = await this.modalCtrl.create({
      component: PhotoViewerPage,
      componentProps: {
        imageUrls: photoData,
        index: 1,
        isCircle: false,
        enableDelete: true,
        toolbarColorScheme: 'dark',
        labels: {
          delete: 'Delete',
        },
      } satisfies PhotoViewerProps,
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<PhotoViewerResult>();
    if (data?.action === 'delete') {
      console.log(data);
      // User delete image
    }
  }
}
