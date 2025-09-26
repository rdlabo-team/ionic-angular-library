import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar, Platform } from '@ionic/angular/standalone';
import iconsData from 'ionicons/dist/ionicons.json';

@Component({
  selector: 'app-health-page',
  templateUrl: './health-page.component.html',
  styleUrls: ['./health-page.component.scss'],
  imports: [IonContent, IonHeader, IonTitle, IonToolbar, CommonModule, FormsModule, IonIcon, IonButton, IonButtons],
})
export class HealthPage {
  readonly platform = inject(Platform);

  readonly sourceIonIcons = iconsData.icons.map((icon) => icon.name);

  trackByFn = (_: number, item: string) => item;
}
