import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular/standalone';

@Component({
  selector: 'app-scroll-reverse',
  templateUrl: './scroll-reverse.page.html',
  styleUrls: ['./scroll-reverse.page.scss'],
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar, CommonModule, FormsModule, IonBackButton, IonButtons, IonButton, IonIcon],
})
export class ScrollReversePage implements OnInit {
  constructor() {}

  ngOnInit() {}
}
