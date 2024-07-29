import { Component, computed, effect, OnInit, signal } from '@angular/core';
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
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-scroll-strategies',
  templateUrl: './scroll-strategies.page.html',
  styleUrls: ['./scroll-strategies.page.scss'],
  standalone: true,
  imports: [
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    CommonModule,
    FormsModule,
    CdkVirtualScrollViewport,
    CdkVirtualForOf,
    IonButton,
    IonButtons,
    IonIcon,
    IonList,
    IonItem,
    IonLabel,
    RouterLink,
  ],
})
export class ScrollStrategiesPage implements OnInit {
  constructor() {}

  ngOnInit() {}
}
