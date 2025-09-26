import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonAvatar,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonImg,
  IonItem,
  IonItemGroup,
  IonLabel,
  IonList,
  IonNote,
  IonSearchbar,
  IonTitle,
  IonToggle,
  IonToolbar,
  Platform,
} from '@ionic/angular/standalone';
import iconsData from 'ionicons/dist/ionicons.json';

@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss'],
  imports: [
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    CommonModule,
    FormsModule,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonButton,
    IonButtons,
    IonFooter,
    IonSearchbar,
    IonBackButton,
    IonAvatar,
    IonImg,
    IonNote,
    IonItemGroup,
    IonToggle,
  ],
})
export class SettingsPage {
  readonly platform = inject(Platform);
}
