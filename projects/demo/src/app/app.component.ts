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
import {
  ModalController,
  IonHeader,
  IonToolbar,
  IonContent,
  IonList,
  IonItem,
  IonLabel,
  IonTitle,
  IonListHeader,
  IonApp,
  IonNote,
  IonIcon,
  IonButtons,
  IonButton,
  IonRouterOutlet,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { planetOutline } from 'ionicons/icons';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [IonRouterOutlet, IonApp],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {}
