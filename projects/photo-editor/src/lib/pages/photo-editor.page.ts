import { coerceNumberProperty, coerceBooleanProperty, BooleanInput, NumberInput } from '@angular/cdk/coercion';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
  numberAttribute,
  booleanAttribute,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, ModalController, RangeCustomEvent, ViewDidEnter, ViewDidLeave } from '@ionic/angular/standalone';
import ImageEditor from 'tui-image-editor';
import { filterPreset } from '../filter-preset';
import { Subscription } from 'rxjs';
import { toObservable } from '@angular/core/rxjs-interop';
import { IDictionaryForEditor, IFilter, IPhotoEditorDismiss, ISize } from '../types';
import { HelperService } from '../service/helper.service';
import { ionComponents } from '../ion-components';
import { dictionaryForEditor } from '../dictionaries';

@Component({
  selector: 'app-editor-image',
  templateUrl: './photo-editor.page.html',
  styleUrls: ['./core.scss', './photo-editor.page.scss'],
  imports: [CommonModule, FormsModule, ...ionComponents],
  providers: [HelperService],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoEditorPage implements OnInit, OnDestroy, ViewDidEnter, ViewDidLeave {
  readonly modalCtrl = inject(ModalController);
  private readonly service = inject(HelperService);

  protected readonly dictionary = signal<IDictionaryForEditor>(dictionaryForEditor());

  readonly requireSquare = input<boolean, BooleanInput>(false, {
    transform: coerceBooleanProperty,
  });
  readonly labels = input<Partial<IDictionaryForEditor> | undefined>(undefined);
  readonly setLabels = effect(() => {
    if (this.labels()) {
      this.dictionary.update((value) => ({ ...value, ...this.labels() }));
    }
  });
  readonly value = input.required<string>();

  readonly editorRef = viewChild.required<ElementRef>('imageEditor');
  readonly ionContent = viewChild.required(IonContent, { read: ElementRef });

  readonly filters = signal<IFilter[]>([]);
  readonly footerMenu = signal<'filter' | 'menu' | 'crop' | 'brightness'>('menu');
  readonly currentCrop = signal<'cover' | '16/9' | '1' | 'auto'>('cover');
  readonly currentRotate = signal<number>(0);
  readonly photoCrop = signal<ISize>({
    width: 0,
    height: 0,
  });
  readonly isCropped = signal<boolean>(false);
  private readonly adoptFilter = signal<IFilter | undefined>(undefined);
  protected readonly filterPreset = computed(() => filterPreset(this.dictionary()));

  private readonly footerMenu$ = toObservable(this.footerMenu);

  private readonly initSubscription$: Subscription[] = [];
  private readonly filterImageSize = 240;
  private editorInstance!: ImageEditor;

  private canvasContainerObserver: MutationObserver = new MutationObserver((mutationsList: MutationRecord[]) => {
    if (mutationsList.find((mutation) => mutation.type === 'attributes' && mutation.attributeName === 'style')) {
      // Cover the image editor with the parent element
      const editorRef = this.editorRef();
      editorRef.nativeElement.style.minWidth = mutationsList[0].target.parentElement!.style.maxWidth;
      editorRef.nativeElement.style.minHeight = mutationsList[0].target.parentElement!.style.maxHeight;

      this.photoCrop.set({
        width: mutationsList[0].target.parentElement!.querySelector('canvas')!.width,
        height: mutationsList[0].target.parentElement!.querySelector('canvas')!.height,
      });
    }
  });

  constructor() {
    this.service.initializeEditorIcons();
  }

  ngOnInit() {
    this.initSubscription$.push(
      this.footerMenu$.subscribe((value) => {
        if (value === 'filter') {
          this.initializeFilterMenu().then();
        }
        if (value === 'crop') {
          this.editorInstance.startDrawingMode('CROPPER');
          this.changeCrop(this.requireSquare() ? '1' : 'cover');
        }
      }),
    );
  }

  ngOnDestroy() {
    this.initSubscription$.forEach((subscription) => subscription.unsubscribe());
  }

  async ionViewDidEnter() {
    this.editorInstance = new ImageEditor(this.editorRef().nativeElement, {
      cssMaxWidth: this.ionContent().nativeElement.clientWidth - 32,
      cssMaxHeight: this.ionContent().nativeElement.clientHeight - 32,
    });
    this.service.waitToFindDom(this.editorRef().nativeElement, '.tui-image-editor-canvas-container').then(() => {
      this.canvasContainerObserver.observe(this.editorRef().nativeElement.querySelector('.tui-image-editor-canvas-container'), {
        attributes: true,
        childList: false,
        subtree: true,
      });
    });
    const blob = await fetch(this.value()).then((res) => res.blob());
    await this.editorInstance.loadImageFromFile(new File([blob], 'data.png', { type: blob.type }));
    this.footerMenu.set(this.requireSquare() ? 'crop' : 'menu');
  }

  ionViewDidLeave() {
    this.editorInstance.destroy();
    this.canvasContainerObserver.disconnect();
  }

  changeCrop(crop: 'cover' | '16/9' | '1' | 'auto') {
    const rect = crop === 'cover' ? this.photoCrop().width / this.photoCrop().height : crop === '16/9' ? 16 / 9 : 1;
    this.editorInstance.setCropzoneRect(crop !== 'auto' ? rect : undefined);
    this.currentCrop.set(crop);
  }

  async rotate() {
    this.editorInstance.stopDrawingMode();
    await this.editorInstance.rotate(90);
    this.currentRotate.update((value) => value + 90);
    this.editorInstance.startDrawingMode('CROPPER');
    requestAnimationFrame(() => this.changeCrop(this.currentCrop()));
  }

  async closeCrop(type: 'cancel' | 'apply') {
    if (this.footerMenu() === 'crop') {
      if (type === 'cancel') {
        await this.editorInstance.rotate(this.currentRotate() * -1);
      } else {
        await this.editorInstance.crop(this.editorInstance.getCropzoneRect());
        this.isCropped.set(true);
      }
      this.currentRotate.set(0);
      this.currentCrop.set('cover');
      this.editorInstance.stopDrawingMode();
    } else if (this.footerMenu() === 'brightness') {
      if (type === 'cancel' && this.editorInstance.hasFilter('brightness')) {
        await this.editorInstance.removeFilter('brightness');
      }
    }
    this.footerMenu.set('menu');
  }

  async changeRange(event: RangeCustomEvent) {
    if (this.editorInstance.hasFilter('brightness')) {
      await this.editorInstance.removeFilter('brightness');
    }
    await this.editorInstance.applyFilter('brightness', {
      brightness: Number(event.detail.value) / 255,
    });
  }

  imageSave() {
    const value = this.editorInstance.toDataURL();
    this.modalCtrl.dismiss({ value } as IPhotoEditorDismiss);
  }

  private async initializeFilterMenu() {
    const filters: IFilter[] = [];

    const defaultInstance = new ImageEditor(document.createElement('div'), {
      cssMaxWidth: this.filterImageSize,
      cssMaxHeight: (this.photoCrop().height * this.filterImageSize) / this.photoCrop().width,
    });
    const blob = await fetch(
      this.editorInstance.toDataURL({
        multiplier: this.filterImageSize / this.photoCrop().width,
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
        height: (this.photoCrop().height * this.filterImageSize) / this.photoCrop().width,
      });
      if (filter.type !== 'Default') {
        await defaultInstance.removeFilter(filter.type);
      }
    }
    this.filters.set(filters);
    defaultInstance.destroy();
  }

  async filterImage(filter: IFilter) {
    if (this.adoptFilter()) {
      await this.editorInstance.removeFilter(this.adoptFilter()!.type);
    }
    if (filter.type === 'Default') {
      this.adoptFilter.set(undefined);
      return;
    }
    await this.editorInstance.applyFilter(filter.type, filter.option);
    this.adoptFilter.set(filter);
  }
}
