import { BooleanInput, coerceBooleanProperty } from '@angular/cdk/coercion';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, ModalController, RangeCustomEvent, ViewDidEnter, ViewDidLeave } from '@ionic/angular';
import {
  PHOTO_EDITOR_CONFIG,
  PhotoEditorLabels,
  PhotoEditorResult,
  PhotoFilter,
  PhotoImageEditor,
  PhotoSize,
  PhotoToolbarColorScheme,
} from '@rdlabo/ionic-angular-photo-editor';
import { filterPreset } from './filter-preset';
import { ionComponents } from './ion-components';
import { dictionaryForEditor, initializeEditorIcons } from './internals';

@Component({
  selector: 'rdlabo-photo-editor',
  templateUrl: './photo-editor.page.html',
  styleUrls: ['../../../src/lib/pages/core.scss', './photo-editor.page.scss'],
  imports: [CommonModule, FormsModule, ...ionComponents],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
/** Ionic modal page for cropping, rotating, filtering, and saving a photo. */
export class PhotoEditorPage implements OnDestroy, ViewDidEnter, ViewDidLeave {
  protected readonly modalCtrl = inject(ModalController);
  readonly #config = inject(PHOTO_EDITOR_CONFIG);

  readonly requireSquare = input<boolean, BooleanInput>(false, {
    transform: coerceBooleanProperty,
  });
  readonly labels = input<Partial<PhotoEditorLabels> | undefined>(undefined);
  readonly toolbarColorScheme = input.required<PhotoToolbarColorScheme>();
  readonly value = input.required<string>();

  protected readonly dictionary = computed<PhotoEditorLabels>(() => ({ ...dictionaryForEditor(), ...this.labels() }));
  private readonly editorRef = viewChild.required<ElementRef>('imageEditor');
  private readonly ionContent = viewChild.required(IonContent, { read: ElementRef });

  protected readonly filters = signal<PhotoFilter[]>([]);
  protected readonly footerMenu = signal<'filter' | 'menu' | 'crop' | 'brightness'>('menu');
  protected readonly currentCrop = signal<'cover' | '16/9' | '1' | 'auto'>('cover');
  protected readonly currentRotate = signal<number>(0);
  protected readonly photoCrop = signal<PhotoSize>({
    width: 0,
    height: 0,
  });
  protected readonly isCropped = signal<boolean>(false);
  private readonly adoptFilter = signal<PhotoFilter | undefined>(undefined);
  protected readonly filterPreset = computed(() => filterPreset(this.dictionary()));

  private readonly filterImageSize = 240;
  private editorInstance: PhotoImageEditor | undefined;
  private initializationGeneration = 0;

  private readonly footerMenuEffect = effect(() => {
    const menu = this.footerMenu();
    const editor = this.editorInstance;
    if (!editor) {
      return;
    }
    if (menu === 'filter') {
      void this.initializeFilterMenu();
    } else if (menu === 'crop') {
      editor.startDrawingMode('CROPPER');
      this.changeCrop(this.requireSquare() ? '1' : 'cover');
    }
  });

  private canvasContainer: HTMLElement | undefined;
  private readonly canvasContainerObserver = new MutationObserver(() => this.syncCanvasSize());

  constructor() {
    initializeEditorIcons();
  }

  ngOnDestroy() {
    this.initializationGeneration += 1;
    this.destroyEditor();
  }

  async ionViewDidEnter() {
    const generation = ++this.initializationGeneration;
    const editor = await this.#config.createImageEditor(this.editorRef().nativeElement, {
      cssMaxWidth: this.ionContent().nativeElement.clientWidth - 32,
      cssMaxHeight: this.ionContent().nativeElement.clientHeight - 32,
    });
    if (generation !== this.initializationGeneration) {
      editor.destroy();
      return;
    }
    this.editorInstance = editor;
    return this.initializeEditor(editor, generation).catch((error: unknown) => {
      if (this.editorInstance === editor) {
        this.destroyEditor();
      }
      throw error;
    });
  }

  private async initializeEditor(editor: PhotoImageEditor, generation: number): Promise<void> {
    const response = await fetch(this.value());
    if (!this.isCurrentEditor(editor, generation)) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Unable to load photo: ${response.status}`);
    }
    const blob = await response.blob();
    if (!this.isCurrentEditor(editor, generation)) {
      return;
    }
    await editor.loadImageFromFile(new File([blob], 'data.png', { type: blob.type }));
    if (!this.isCurrentEditor(editor, generation)) {
      return;
    }
    const editorElement = this.editorRef().nativeElement as HTMLElement;
    this.canvasContainer = editorElement.querySelector<HTMLElement>('.tui-image-editor-canvas-container') ?? undefined;
    if (this.canvasContainer) {
      this.syncCanvasSize();
      this.canvasContainerObserver.observe(this.canvasContainer, {
        attributes: true,
        childList: false,
        subtree: true,
      });
    }
    this.footerMenu.set(this.requireSquare() ? 'crop' : 'menu');
  }

  ionViewDidLeave() {
    this.initializationGeneration += 1;
    this.destroyEditor();
  }

  changeCrop(crop: 'cover' | '16/9' | '1' | 'auto') {
    const rect = crop === 'cover' ? this.photoCrop().width / this.photoCrop().height : crop === '16/9' ? 16 / 9 : 1;
    this.editorInstance?.setCropzoneRect(crop !== 'auto' ? rect : undefined);
    this.currentCrop.set(crop);
  }

  async rotate() {
    const editor = this.requireEditor();
    editor.stopDrawingMode();
    await editor.rotate(90);
    this.currentRotate.update((value) => value + 90);
    editor.startDrawingMode('CROPPER');
    requestAnimationFrame(() => this.changeCrop(this.currentCrop()));
  }

  async closeCrop(type: 'cancel' | 'apply') {
    const editor = this.requireEditor();
    if (this.footerMenu() === 'crop') {
      if (type === 'cancel') {
        await editor.rotate(this.currentRotate() * -1);
      } else {
        await editor.crop(editor.getCropzoneRect());
        this.isCropped.set(true);
      }
      this.currentRotate.set(0);
      this.currentCrop.set('cover');
      editor.stopDrawingMode();
    } else if (this.footerMenu() === 'brightness') {
      if (type === 'cancel' && editor.hasFilter('brightness')) {
        await editor.removeFilter('brightness');
      }
    }
    this.footerMenu.set('menu');
  }

  async changeRange(event: RangeCustomEvent) {
    const editor = this.requireEditor();
    if (editor.hasFilter('brightness')) {
      await editor.removeFilter('brightness');
    }
    await editor.applyFilter('brightness', {
      brightness: Number(event.detail.value) / 255,
    });
  }

  imageSave() {
    const value = this.requireEditor().toDataURL();
    void this.modalCtrl.dismiss({ action: 'save', value } satisfies PhotoEditorResult);
  }

  private async initializeFilterMenu() {
    const editor = this.requireEditor();
    const filters: PhotoFilter[] = [];

    const defaultInstance = await this.#config.createImageEditor(document.createElement('div'), {
      cssMaxWidth: this.filterImageSize,
      cssMaxHeight: (this.photoCrop().height * this.filterImageSize) / this.photoCrop().width,
    });
    const blob = await fetch(
      editor.toDataURL({
        multiplier: this.filterImageSize / this.photoCrop().width,
      }),
    ).then((res) => res.blob());
    await defaultInstance.loadImageFromFile(new File([blob], 'defaultInstance.png', { type: blob.type }));

    for (const filter of this.filterPreset()) {
      if (filter.type !== 'Default') {
        await defaultInstance.applyFilter(filter.type, filter.option ?? undefined);
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

  async filterImage(filter: PhotoFilter) {
    const editor = this.requireEditor();
    if (this.adoptFilter()) {
      await editor.removeFilter(this.adoptFilter()!.type);
    }
    if (filter.type === 'Default') {
      this.adoptFilter.set(undefined);
      return;
    }
    await editor.applyFilter(filter.type, filter.option ?? undefined);
    this.adoptFilter.set(filter);
  }

  private requireEditor(): PhotoImageEditor {
    if (!this.editorInstance) {
      throw new Error('Photo editor is not initialized.');
    }
    return this.editorInstance;
  }

  private destroyEditor(): void {
    this.canvasContainerObserver.disconnect();
    this.canvasContainer = undefined;
    this.editorInstance?.destroy();
    this.editorInstance = undefined;
  }

  private isCurrentEditor(editor: PhotoImageEditor, generation: number): boolean {
    return generation === this.initializationGeneration && editor === this.editorInstance;
  }

  private syncCanvasSize(): void {
    const container = this.canvasContainer;
    const canvas = container?.querySelector<HTMLCanvasElement>('canvas');
    if (!container || !canvas) {
      return;
    }
    const bounds = container.parentElement ?? container;
    const editor = this.editorRef().nativeElement;
    editor.style.minWidth = bounds.style.maxWidth;
    editor.style.minHeight = bounds.style.maxHeight;
    this.photoCrop.set({ width: canvas.width, height: canvas.height });
  }
}
