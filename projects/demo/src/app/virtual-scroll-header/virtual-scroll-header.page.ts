import { Component, inject, OnInit } from '@angular/core';
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
  IonTitle,
  IonToolbar,
  Platform,
} from '@ionic/angular/standalone';
import { CdkFixedSizeVirtualScroll, CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import iconsData from 'ionicons/dist/ionicons.json';
import { VirtualScrollHeaderDirective } from '@rdlabo/ionic-angular-scroll-header';

@Component({
  selector: 'app-virtual-scroll-header',
  templateUrl: './virtual-scroll-header.page.html',
  styleUrls: ['./virtual-scroll-header.page.scss'],
  standalone: true,
  imports: [
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    CommonModule,
    FormsModule,
    CdkFixedSizeVirtualScroll,
    CdkVirtualScrollViewport,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    CdkVirtualForOf,
    VirtualScrollHeaderDirective,
    IonButton,
    IonButtons,
  ],
})
export class VirtualScrollHeaderPage implements OnInit {
  sourceIonIcons = iconsData.icons.map((icon) => icon.name).slice(0, 80);
  platform = inject(Platform);
  constructor() {}

  ngOnInit() {}

  trackByFn = (_: number, item: string) => item;
}
