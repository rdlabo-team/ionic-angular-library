import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { PhotoEditorPage, IPhotoEditorDismiss } from '@rdlabo/ionic-angular-photo-editor';
import { ModalController } from '@ionic/angular/standalone';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  title = 'ionic-angular-library';
  modalCtrl = inject(ModalController);

  async ngOnInit() {
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
}
