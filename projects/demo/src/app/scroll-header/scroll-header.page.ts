import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';

@Component({
  selector: 'app-scroll-header',
  templateUrl: './scroll-header.page.html',
  styleUrls: ['./scroll-header.page.scss'],
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar, CommonModule, FormsModule],
})
export class ScrollHeaderPage implements OnInit {
  constructor() {}

  ngOnInit() {}
}
