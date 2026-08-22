import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { vi } from 'vitest';
import { PhotoEditorPage } from './photo-editor.page';
import { testConfig } from '../../../../../util/test.config';
import { IFilter } from '../../types';

interface EditorMock {
  applyFilter: ReturnType<typeof vi.fn>;
  crop: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  getCropzoneRect: ReturnType<typeof vi.fn>;
  hasFilter: ReturnType<typeof vi.fn>;
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

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(PhotoEditorPage);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('value', 'data:image/png;base64,');
    componentRef.setInput('headerButtonColorScheme', 'dark');
    fixture.detectChanges();
    editor = createEditorMock();
    Reflect.set(component, 'editorInstance', editor);
  });

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
    componentRef.setInput('headerButtonColorScheme', 'light');
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
    componentRef.setInput('labels', { save: 'Upload' });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('Upload');
    expect(fixture.nativeElement.textContent).toContain('切り抜き・回転');
  });

  it.each([
    ['cover', 2],
    ['16/9', 16 / 9],
    ['1', 1],
    ['auto', undefined],
  ] as const)('sets the %s crop ratio', (crop, expectedRatio) => {
    component.photoCrop.set({ width: 400, height: 200 });

    component.changeCrop(crop);

    expect(editor.setCropzoneRect).toHaveBeenCalledWith(expectedRatio);
    expect(component.currentCrop()).toBe(crop);
  });

  it('applies the crop and resets crop state when closing the crop menu', async () => {
    component.footerMenu.set('crop');
    await fixture.whenStable();
    vi.clearAllMocks();

    await component.closeCrop('apply');

    expect(editor.crop).toHaveBeenCalledWith({ left: 1, top: 2, width: 30, height: 40 });
    expect(editor.stopDrawingMode).toHaveBeenCalledOnce();
    expect(component.isCropped()).toBe(true);
    expect(component.currentCrop()).toBe('cover');
    expect(component.currentRotate()).toBe(0);
    expect(component.footerMenu()).toBe('menu');
  });

  it('replaces an adopted filter and clears it when Default is selected', async () => {
    const sepia: IFilter = { name: 'Sepia', type: 'Sepia', option: null, data: '', width: 1, height: 1 };
    const grayscale: IFilter = { name: 'Gray', type: 'Grayscale', option: null, data: '', width: 1, height: 1 };
    const original: IFilter = { name: 'Original', type: 'Default', option: null, data: '', width: 1, height: 1 };

    await component.filterImage(sepia);
    await component.filterImage(grayscale);
    await component.filterImage(original);

    expect(editor.applyFilter).toHaveBeenNthCalledWith(1, 'Sepia', null);
    expect(editor.applyFilter).toHaveBeenNthCalledWith(2, 'Grayscale', null);
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
    const dismiss = vi.spyOn(component.modalCtrl, 'dismiss').mockResolvedValue(true);

    component.imageSave();

    expect(editor.toDataURL).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledWith({ value: 'data:image/png;base64,saved' });
  });

  it('destroys the editor when the view leaves', () => {
    component.ionViewDidLeave();

    expect(editor.destroy).toHaveBeenCalledOnce();
  });
});
