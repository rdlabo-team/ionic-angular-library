import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { PhotoEditorPage, PhotoViewerPage, IPhotoEditorDismiss, IPhotoViewerDismiss } from '@rdlabo/ionic-angular-photo-editor';
import { ModalController, IonHeader, IonToolbar, IonContent, IonList, IonItem, IonLabel, IonTitle } from '@ionic/angular/standalone';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, IonHeader, IonToolbar, IonContent, IonList, IonItem, IonLabel, IonTitle],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  private modalCtrl = inject(ModalController);

  constructor() {}

  async ngOnInit() {}

  async launchEditor() {
    const modal = await this.modalCtrl.create({
      component: PhotoEditorPage,
      componentProps: {
        requireSquare: false,
        value: 'https://picsum.photos/200/300',
      },
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<IPhotoEditorDismiss>();
    if (data?.value) {
      console.log(data.value);
    }
  }

  async launchViewer() {
    const modal = await this.modalCtrl.create({
      component: PhotoViewerPage,
      componentProps: {
        imageUrls: [
          'https://dy60q458bmneq.cloudfront.net/attachment/110807_1702425701017_0.png',
          'https://dy60q458bmneq.cloudfront.net/attachment/110807_1702425701017_0.png',
        ],
        index: 1,
        isCircle: false,
      },
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<IPhotoViewerDismiss>();
    if (data?.delete) {
      // User delete image
    }
  }
}
