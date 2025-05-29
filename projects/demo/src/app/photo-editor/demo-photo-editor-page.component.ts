import { Component, inject, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
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
  IonLabel,
  IonList,
  IonListHeader,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular/standalone';
import { IPhotoEditorDismiss, IPhotoViewerDismiss, PhotoEditorPage, PhotoFileService, PhotoViewerPage } from 'photo-editor';

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
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DemoPhotoEditorPage implements OnInit {
  private readonly photoFileService = inject(PhotoFileService);
  private readonly modalCtrl = inject(ModalController);

  constructor() {
    this.photoFileService.photoMaxSize = 1000;
    this.photoFileService.labels = {
      camera: 'Camera',
      album: 'Album',
      cancel: 'Cancel',
    };
  }

  async ngOnInit() {}

  async selectPhoto(type: 'editor' | 'viewer') {
    if (type === 'editor') {
      const data = await this.photoFileService.loadPhoto(1);
      await this.launchEditor(data[0]);
    } else {
      const data = await this.photoFileService.loadPhoto(2);
      await this.launchViewer(data);
    }
  }

  async launchEditor(photoData: string = 'https://picsum.photos/200/300') {
    const modal = await this.modalCtrl.create({
      component: PhotoEditorPage,
      componentProps: {
        requireSquare: false,
        value: photoData,
      },
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<IPhotoEditorDismiss>();
    if (data?.value) {
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
        labels: {
          delete: 'Delete',
        },
      },
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<IPhotoViewerDismiss>();
    if (data?.delete) {
      console.log(data.delete);
      // User delete image
    }
  }
}
