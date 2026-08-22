import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef, WritableSignal } from '@angular/core';
import { ModalController } from '@ionic/angular';
import { vi } from 'vitest';
import { PhotoFilter, PhotoSize, providePhotoEditor } from '@rdlabo/ionic-angular-photo-editor';
import { testConfig } from '../../../util/test.config';
import { PhotoEditorPage } from '../../editor/src/lib/photo-editor.page';

interface EditorMock {
  applyFilter: ReturnType<typeof vi.fn>;
  crop: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  getCropzoneRect: ReturnType<typeof vi.fn>;
  hasFilter: ReturnType<typeof vi.fn>;
  loadImageFromFile: ReturnType<typeof vi.fn>;
  removeFilter: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>;
  setCropzoneRect: ReturnType<typeof vi.fn>;
  startDrawingMode: ReturnType<typeof vi.fn>;
  stopDrawingMode: ReturnType<typeof vi.fn>;
  toDataURL: ReturnType<typeof vi.fn>;
}

const createEditorMock = (): EditorMock => ({
  applyFilter: vi.fn().mockResolvedValue(undefined),
  crop: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
  getCropzoneRect: vi.fn().mockReturnValue({ left: 1, top: 2, width: 30, height: 40 }),
  hasFilter: vi.fn().mockReturnValue(false),
  loadImageFromFile: vi.fn().mockResolvedValue({ newWidth: 400, newHeight: 200 }),
  removeFilter: vi.fn().mockResolvedValue(undefined),
  rotate: vi.fn().mockResolvedValue(undefined),
  setCropzoneRect: vi.fn(),
  startDrawingMode: vi.fn(),
  stopDrawingMode: vi.fn(),
  toDataURL: vi.fn().mockReturnValue('data:image/png;base64,saved'),
});

describe('PhotoEditorPage', () => {
  let component: PhotoEditorPage;
  let fixture: ComponentFixture<PhotoEditorPage>;
  let componentRef: ComponentRef<PhotoEditorPage>;
  let editor: EditorMock;
  let createImageEditor: ReturnType<typeof vi.fn>;
  let modalCtrl: ModalController;
  let state: {
    currentCrop: WritableSignal<'cover' | '16/9' | '1' | 'auto'>;
    currentRotate: WritableSignal<number>;
    footerMenu: WritableSignal<'filter' | 'menu' | 'crop' | 'brightness'>;
    isCropped: WritableSignal<boolean>;
    photoCrop: WritableSignal<PhotoSize>;
    editorRef: () => { nativeElement: HTMLElement };
  };

  beforeEach(() => {
    editor = createEditorMock();
    createImageEditor = vi.fn().mockResolvedValue(editor);
    TestBed.configureTestingModule({
      providers: [testConfig.providers, providePhotoEditor({ createImageEditor: createImageEditor as never })],
    });
    fixture = TestBed.createComponent(PhotoEditorPage);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('value', 'data:image/png;base64,');
    componentRef.setInput('toolbarColorScheme', 'dark');
    fixture.detectChanges();
    modalCtrl = TestBed.inject(ModalController);
    state = component as unknown as typeof state;
    Reflect.set(component, 'editorInstance', editor);
  });

  afterEach(() => vi.restoreAllMocks());

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('applies the configured dark color scheme to the header', () => {
    const header = fixture.nativeElement.querySelector('ion-header');
    const closeButton = header.querySelector('ion-button');

    expect(header.classList.contains('photo-editor-header-buttons-dark')).toBe(true);
    expect(header.classList.contains('photo-editor-header-buttons-light')).toBe(false);
    expect(header.style.colorScheme).toBe('dark');
    expect(getComputedStyle(closeButton).getPropertyValue('--color').trim()).toBe(
      'var(--ion-photo-editor-header-button-color-on-dark, #f4f5f8)',
    );
  });

  it('applies the configured light color scheme to regular Ionic buttons', () => {
    componentRef.setInput('toolbarColorScheme', 'light');
    fixture.detectChanges();
    const header = fixture.nativeElement.querySelector('ion-header');
    const closeButton = header.querySelector('ion-button');

    expect(header.classList.contains('photo-editor-header-buttons-dark')).toBe(false);
    expect(header.classList.contains('photo-editor-header-buttons-light')).toBe(true);
    expect(header.style.colorScheme).toBe('light');
    expect(getComputedStyle(closeButton).getPropertyValue('--color').trim()).toBe(
      'var(--ion-photo-editor-header-button-color-on-light, #222428)',
    );
  });

  it('merges custom labels without replacing the remaining dictionary', async () => {
    componentRef.setInput('labels', { save: 'Upload', close: 'Close editor', brightness: 'Exposure' });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('Upload');
    expect(fixture.nativeElement.textContent).toContain('切り抜き・回転');
    expect(fixture.nativeElement.querySelector('ion-button').getAttribute('aria-label')).toBe('Close editor');

    state.footerMenu.set('brightness');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-range').getAttribute('aria-label')).toBe('Exposure');
  });

  it.each([
    ['cover', 2],
    ['16/9', 16 / 9],
    ['1', 1],
    ['auto', undefined],
  ] as const)('sets the %s crop ratio', (crop, expectedRatio) => {
    state.photoCrop.set({ width: 400, height: 200 });

    component.changeCrop(crop);

    expect(editor.setCropzoneRect).toHaveBeenCalledWith(expectedRatio);
    expect(state.currentCrop()).toBe(crop);
  });

  it('applies the crop and resets crop state when closing the crop menu', async () => {
    state.footerMenu.set('crop');
    await fixture.whenStable();
    vi.clearAllMocks();

    await component.closeCrop('apply');

    expect(editor.crop).toHaveBeenCalledWith({ left: 1, top: 2, width: 30, height: 40 });
    expect(editor.stopDrawingMode).toHaveBeenCalledOnce();
    expect(state.isCropped()).toBe(true);
    expect(state.currentCrop()).toBe('cover');
    expect(state.currentRotate()).toBe(0);
    expect(state.footerMenu()).toBe('menu');
  });

  it('replaces an adopted filter and clears it when Default is selected', async () => {
    const sepia: PhotoFilter = { name: 'Sepia', type: 'Sepia', option: null, data: '', width: 1, height: 1 };
    const grayscale: PhotoFilter = { name: 'Gray', type: 'Grayscale', option: null, data: '', width: 1, height: 1 };
    const original: PhotoFilter = { name: 'Original', type: 'Default', option: null, data: '', width: 1, height: 1 };

    await component.filterImage(sepia);
    await component.filterImage(grayscale);
    await component.filterImage(original);

    expect(editor.applyFilter).toHaveBeenNthCalledWith(1, 'Sepia', undefined);
    expect(editor.applyFilter).toHaveBeenNthCalledWith(2, 'Grayscale', undefined);
    expect(editor.removeFilter).toHaveBeenNthCalledWith(1, 'Sepia');
    expect(editor.removeFilter).toHaveBeenNthCalledWith(2, 'Grayscale');
  });

  it('replaces the brightness filter using the normalized range value', async () => {
    editor.hasFilter.mockReturnValue(true);

    await component.changeRange({ detail: { value: 127.5 } } as never);

    expect(editor.removeFilter).toHaveBeenCalledWith('brightness');
    expect(editor.applyFilter).toHaveBeenCalledWith('brightness', { brightness: 0.5 });
  });

  it('dismisses with the current editor data URL when saving', () => {
    const dismiss = vi.spyOn(modalCtrl, 'dismiss').mockResolvedValue(true);

    component.imageSave();

    expect(editor.toDataURL).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledWith({ action: 'save', value: 'data:image/png;base64,saved' });
  });

  it('creates and loads the editor through the configured adapter on entry', async () => {
    const content = fixture.nativeElement.querySelector('ion-content');
    Object.defineProperties(content, {
      clientWidth: { configurable: true, value: 432 },
      clientHeight: { configurable: true, value: 632 },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
    } as never);
    const bounds = document.createElement('div');
    bounds.style.maxWidth = '400px';
    bounds.style.maxHeight = '600px';
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'tui-image-editor-canvas-container';
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    canvasContainer.append(canvas);
    bounds.append(canvasContainer);
    state.editorRef().nativeElement.append(bounds);

    await component.ionViewDidEnter();

    expect(createImageEditor).toHaveBeenCalledWith(state.editorRef().nativeElement, {
      cssMaxWidth: 400,
      cssMaxHeight: 600,
    });
    expect(editor.loadImageFromFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'data.png', type: 'image/png' }));
    expect(state.photoCrop()).toEqual({ width: 400, height: 200 });
    expect(state.editorRef().nativeElement.style.minWidth).toBe('400px');
    expect(state.editorRef().nativeElement.style.minHeight).toBe('600px');
  });

  it('destroys an adapter that resolves after the modal has left', async () => {
    Reflect.set(component, 'editorInstance', undefined);
    const delayedEditor = createEditorMock();
    let resolveEditor!: (value: EditorMock) => void;
    createImageEditor.mockReturnValueOnce(new Promise<EditorMock>((resolve) => (resolveEditor = resolve)));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const entering = component.ionViewDidEnter();
    component.ionViewDidLeave();
    resolveEditor(delayedEditor);
    await entering;

    expect(delayedEditor.destroy).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('destroys an initialized adapter when loading the source fails', async () => {
    Reflect.set(component, 'editorInstance', undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network failure'));

    await expect(component.ionViewDidEnter()).rejects.toThrow('network failure');

    expect(editor.destroy).toHaveBeenCalledOnce();
  });

  it('destroys the editor when the view leaves', () => {
    component.ionViewDidLeave();

    expect(editor.destroy).toHaveBeenCalledOnce();
  });
});
