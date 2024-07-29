import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';

@Component({
  selector: 'app-scroll-advanced',
  templateUrl: './scroll-advanced.page.html',
  styleUrls: ['./scroll-advanced.page.scss'],
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar, CommonModule, FormsModule, IonBackButton, IonButtons],
})
export class ScrollAdvancedPage implements OnInit {
  constructor() {}

  ngOnInit() {}
}
