import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';

@Component({
  selector: 'app-virtual-scroll-header',
  templateUrl: './virtual-scroll-header.page.html',
  styleUrls: ['./virtual-scroll-header.page.scss'],
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar, CommonModule, FormsModule],
})
export class VirtualScrollHeaderPage implements OnInit {
  constructor() {}

  ngOnInit() {}
}
