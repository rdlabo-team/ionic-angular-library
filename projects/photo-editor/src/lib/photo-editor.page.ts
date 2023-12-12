import { Component, ElementRef, inject, Input, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonButtons,
  IonContent, IonFooter,
  IonHeader, IonIcon, IonRange, IonText, IonToolbar,
  ModalController,
  RangeCustomEvent,
  ViewDidEnter,
  ViewDidLeave
} from '@ionic/angular/standalone';
import ImageEditor from 'tui-image-editor';
import { filterPreset } from './filter-preset';
import { Subscription } from 'rxjs';
import { toObservable } from '@angular/core/rxjs-interop';
import { addIcons } from 'ionicons';
import { closeOutline, send, cropOutline, colorFilterOutline, sunnyOutline, expandOutline, tabletLandscapeOutline, squareOutline, refreshOutline, checkmarkOutline } from 'ionicons/icons';

interface IFilter {
  name: string;
  type: string;
  option: any;
  data: string;
  width: number;
  height: number;
}

@Component({
  selector: 'app-editor-image',
  templateUrl: './photo-editor.page.html',
  styleUrls: ['./photo-editor.page.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, NgOptimizedImage, IonHeader, IonToolbar, IonButtons, IonButton, IonIcon, IonContent, IonFooter, IonText, IonRange],
})
export class PhotoEditorPage implements OnInit, OnDestroy, ViewDidEnter, ViewDidLeave {
  @Input() isSend: boolean = false;
  @Input() requireSquare: boolean = false;
  @Input() value!: string;

  @ViewChild('imageEditor', { static: true }) editorRef!: ElementRef;
  @ViewChild(IonContent) ionContent!: {
    el: IonContent & HTMLElement;
  };

  public $filters = signal<IFilter[]>([]);
  public $footerMenu = signal<'filter' | 'menu' | 'crop' | 'brightness'>('menu');
  public $currentCrop = signal<'cover' | '16/9' | '1' | 'auto'>('cover');
  public $currentRotate = signal<number>(0);
  public $photoCrop = signal<{
    width: number;
    height: number;
  }>({
    width: 0,
    height: 0,
  });
  public $isCropped = signal<boolean>(false);
  public filterPreset = () => filterPreset();

  private footerMenu$ = toObservable(this.$footerMenu);
  private $adoptFilter = signal<IFilter | undefined>(undefined);
  private editorInstance!: ImageEditor;
  private initSubscription$: Subscription[] = [];
  private readonly filterImageSize = 240;

  public modalCtrl = inject(ModalController);

  private canvasContainerObserver: MutationObserver = new MutationObserver((mutationsList: MutationRecord[]) => {
    if (mutationsList.find((mutation) => mutation.type === 'attributes' && mutation.attributeName === 'style')) {
      // Cover the image editor with the parent element
      this.editorRef.nativeElement.style.minWidth = mutationsList[0].target.parentElement!.style.maxWidth;
      this.editorRef.nativeElement.style.minHeight = mutationsList[0].target.parentElement!.style.maxHeight;

      this.$photoCrop.set({
        width: mutationsList[0].target.parentElement!.querySelector('canvas')!.width,
        height: mutationsList[0].target.parentElement!.querySelector('canvas')!.height,
      });
    }
  });

  constructor() {
    addIcons({ closeOutline, send, cropOutline, colorFilterOutline, sunnyOutline, expandOutline, tabletLandscapeOutline, squareOutline, refreshOutline, checkmarkOutline });
  }

  ngOnInit() {
    this.initSubscription$.push(
      this.footerMenu$.subscribe((value) => {
        if (value === 'filter') {
          this.initializeFilterMenu().then();
        }
        if (value === 'crop') {
          this.editorInstance.startDrawingMode('CROPPER');
          this.changeCrop(this.requireSquare ? '1' : 'cover');
        }
      }),
    );
  }

  ngOnDestroy() {
    this.initSubscription$.forEach((subscription) => subscription.unsubscribe());
  }

  async ionViewDidEnter() {
    this.editorInstance = new ImageEditor(this.editorRef.nativeElement, {
      cssMaxWidth: this.ionContent.el.clientWidth - 32,
      cssMaxHeight: this.ionContent.el.clientHeight - 32,
    });
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const find = this.editorRef.nativeElement.querySelector('.tui-image-editor-canvas-container');
        if (find) {
          clearInterval(interval);
          resolve();
        }
      });
    });
    this.canvasContainerObserver.observe(this.editorRef.nativeElement.querySelector('.tui-image-editor-canvas-container'), {
      attributes: true,
      childList: false,
      subtree: true,
    });
    const blob = await fetch(this.value).then((res) => res.blob());
    await this.editorInstance.loadImageFromFile(new File([blob], 'data.png', { type: blob.type }));
    this.$footerMenu.set(this.requireSquare ? 'crop' : 'menu');
  }

  ionViewDidLeave() {
    this.editorInstance.destroy();
    this.canvasContainerObserver.disconnect();
  }

  public changeCrop(crop: 'cover' | '16/9' | '1' | 'auto') {
    const rect = crop === 'cover' ? this.$photoCrop().width / this.$photoCrop().height : crop === '16/9' ? 16 / 9 : 1;
    this.editorInstance.setCropzoneRect(crop !== 'auto' ? rect : undefined);
    this.$currentCrop.set(crop);
  }

  public async rotate() {
    this.editorInstance.stopDrawingMode();
    await this.editorInstance.rotate(90);
    this.$currentRotate.update((value) => value + 90);
    this.editorInstance.startDrawingMode('CROPPER');
    requestAnimationFrame(() => this.changeCrop(this.$currentCrop()));
  }

  public async closeCrop(type: 'cancel' | 'apply') {
    if (this.$footerMenu() === 'crop') {
      if (type === 'cancel') {
        await this.editorInstance.rotate(this.$currentRotate() * -1);
      } else {
        await this.editorInstance.crop(this.editorInstance.getCropzoneRect());
        this.$isCropped.set(true);
      }
      this.$currentRotate.set(0);
      this.$currentCrop.set('cover');
      this.editorInstance.stopDrawingMode();
    } else if (this.$footerMenu() === 'brightness') {
      if (type === 'cancel' && this.editorInstance.hasFilter('brightness')) {
        await this.editorInstance.removeFilter('brightness');
      }
    }
    this.$footerMenu.set('menu');
  }

  public async changeRange(event: RangeCustomEvent) {
    if (this.editorInstance.hasFilter('brightness')) {
      await this.editorInstance.removeFilter('brightness');
    }
    this.editorInstance.applyFilter('brightness', { brightness: Number(event.detail.value) / 255 });
  }

  public imageSave() {
    const value = this.editorInstance.toDataURL();
    this.modalCtrl.dismiss({ value });
  }

  private async initializeFilterMenu() {
    const filters: IFilter[] = [];

    const defaultInstance = new ImageEditor(document.createElement('div'), {
      cssMaxWidth: this.filterImageSize,
      cssMaxHeight: (this.$photoCrop().height * this.filterImageSize) / this.$photoCrop().width,
    });
    const blob = await fetch(
      this.editorInstance.toDataURL({
        multiplier: this.filterImageSize / this.$photoCrop().width,
      }),
    ).then((res) => res.blob());
    await defaultInstance.loadImageFromFile(new File([blob], 'defaultInstance.png', { type: blob.type }));

    for (const filter of this.filterPreset()) {
      if (filter.type !== 'Default') {
        await defaultInstance.applyFilter(filter.type, filter.option);
      }
      filters.push({
        name: filter.name,
        type: filter.type,
        option: filter.option,
        data: defaultInstance.toDataURL(),
        width: this.filterImageSize,
        height: (this.$photoCrop().height * this.filterImageSize) / this.$photoCrop().width,
      });
      if (filter.type !== 'Default') {
        await defaultInstance.removeFilter(filter.type);
      }
    }
    this.$filters.set(filters);
    defaultInstance.destroy();
  }

  public async filterImage(filter: IFilter) {
    if (this.$adoptFilter()) {
      await this.editorInstance.removeFilter(this.$adoptFilter()!.type);
    }
    if (filter.type === 'Default') {
      this.$adoptFilter.set(undefined);
      return;
    }
    await this.editorInstance.applyFilter(filter.type, filter.option);
    this.$adoptFilter.set(filter);
  }
}
