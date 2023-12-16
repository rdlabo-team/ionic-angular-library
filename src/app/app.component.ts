import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import {
  PhotoEditorPage,
  PhotoViewerPage,
  IPhotoEditorDismiss,
  IPhotoViewerDismiss,
  PhotoFileService,
} from '@rdlabo/ionic-angular-photo-editor';
import { ModalController, IonHeader, IonToolbar, IonContent, IonList, IonItem, IonLabel, IonTitle } from '@ionic/angular/standalone';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, IonHeader, IonToolbar, IonContent, IonList, IonItem, IonLabel, IonTitle],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  private photoFileService = inject(PhotoFileService);
  private modalCtrl = inject(ModalController);

  constructor() {}

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
      // User delete image
    }
  }
}
