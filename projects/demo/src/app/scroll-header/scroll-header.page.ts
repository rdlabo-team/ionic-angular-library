import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import iconsData from 'ionicons/dist/ionicons.json';
import { ScrollHeaderDirective } from '@rdlabo/ionic-angular-scroll-header';

@Component({
  selector: 'app-scroll-header',
  templateUrl: './scroll-header.page.html',
  styleUrls: ['./scroll-header.page.scss'],
  standalone: true,
  imports: [
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    CommonModule,
    FormsModule,
    IonList,
    IonListHeader,
    IonLabel,
    IonItem,
    IonIcon,
    ScrollHeaderDirective,
    IonButton,
    IonButtons,
    IonNote,
  ],
})
export class ScrollHeaderPage implements OnInit {
  sourceIonIcons = iconsData.icons.map((icon) => icon.name).slice(0, 50);
  constructor() {}

  ngOnInit() {}
}
