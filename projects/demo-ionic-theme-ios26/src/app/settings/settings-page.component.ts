import { Component, inject, OnInit } from '@angular/core';
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
  IonListHeader,
  IonNote,
  IonSearchbar,
  IonTitle,
  IonToggle,
  IonToolbar,
  Platform,
} from '@ionic/angular/standalone';
import { CdkFixedSizeVirtualScroll, CdkVirtualForOf, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import iconsData from 'ionicons/dist/ionicons.json';
import { FixVirtualScrollElementDirective, VirtualScrollHeaderDirective } from '@rdlabo/ionic-angular-scroll-header';

@Component({
  selector: 'app-virtual-scroll-header',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss'],
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
    FixVirtualScrollElementDirective,
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

  readonly sourceIonIcons = iconsData.icons.map((icon) => icon.name);

  trackByFn = (_: number, item: string) => item;
}
