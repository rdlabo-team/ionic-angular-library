import { TestBed } from '@angular/core/testing';
import { ActionSheetController, Platform } from '@ionic/angular';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import ImageEditor from 'tui-image-editor';
import { vi } from 'vitest';

import { PhotoEditorErrors } from '../photoEditorErrors';
import { PhotoFileService } from './photo-file.service';

vi.mock('@capacitor/camera', () => ({
  Camera: {
    getPhoto: vi.fn(),
    pickImages: vi.fn(),
  },
  CameraResultType: { DataUrl: 'dataUrl' },
  CameraSource: { Camera: 'CAMERA' },
}));

vi.mock('tui-image-editor', () => ({ default: vi.fn() }));

describe('PhotoFileService', () => {
  let service: PhotoFileService;
  let isPlatform: ReturnType<typeof vi.fn>;
  let createActionSheet: ReturnType<typeof vi.fn>;
  let getPhoto: ReturnType<typeof vi.fn>;
  let pickImages: ReturnType<typeof vi.fn>;
  let dismissData: 'camera' | 'album' | undefined;
  let actionSheetOptions: { buttons: { text: string; role?: string; handler?: () => void }[] } | undefined;

  beforeEach(() => {
    dismissData = undefined;
    actionSheetOptions = undefined;
    isPlatform = vi.fn().mockReturnValue(true);
    getPhoto = vi.mocked(Camera.getPhoto);
    pickImages = vi.mocked(Camera.pickImages);
    getPhoto.mockReset();
    pickImages.mockReset();
    createActionSheet = vi.fn().mockImplementation(async (options) => {
      actionSheetOptions = options;
      return {
        dismiss: vi.fn().mockResolvedValue(true),
        present: vi.fn().mockResolvedValue(undefined),
        onDidDismiss: vi.fn().mockImplementation(async () => ({ data: dismissData })),
      };
    });

    TestBed.configureTestingModule({
      providers: [
        PhotoFileService,
        { provide: Platform, useValue: { is: isPlatform } },
        { provide: ActionSheetController, useValue: { create: createActionSheet } },
      ],
    });
    service = TestBed.inject(PhotoFileService);
  });

  afterEach(() => {
    document.querySelector('input#browserPhotoUploader')?.remove();
    vi.restoreAllMocks();
  });

  it('rejects browser loading when the required file input is missing', async () => {
    isPlatform.mockReturnValue(false);

    await expect(service.loadPhoto(1)).rejects.toBe(PhotoEditorErrors.initialize);
    expect(createActionSheet).not.toHaveBeenCalled();
  });

  it('rejects browser loading when the file chooser is cancelled', async () => {
    isPlatform.mockReturnValue(false);
    const input = document.createElement('input');
    input.id = 'browserPhotoUploader';
    document.body.append(input);
    vi.spyOn(input, 'click').mockImplementation(() => undefined);

    const result = service.loadPhoto(1);
    input.dispatchEvent(new Event('cancel'));

    await expect(result).rejects.toBe(PhotoEditorErrors.cancel);
    expect(input.click).toHaveBeenCalledOnce();
  });

  it('rejects an empty browser selection without attempting to resize it', async () => {
    isPlatform.mockReturnValue(false);
    const input = document.createElement('input');
    input.id = 'browserPhotoUploader';
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    document.body.append(input);
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    const resize = vi.spyOn(service as unknown as { loadPhotoFromFilePath(path: string): Promise<string> }, 'loadPhotoFromFilePath');

    const result = service.loadPhoto(1);
    input.dispatchEvent(new Event('change'));

    await expect(result).rejects.toBe(PhotoEditorErrors.cancel);
    expect(resize).not.toHaveBeenCalled();
  });

  it('returns the resized result selected by the browser file input', async () => {
    isPlatform.mockReturnValue(false);
    const input = document.createElement('input');
    input.id = 'browserPhotoUploader';
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['image'], 'photo.png', { type: 'image/png' })],
    });
    document.body.append(input);
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    const resize = vi
      .spyOn(service as unknown as { loadPhotoFromFilePath(path: string): Promise<string> }, 'loadPhotoFromFilePath')
      .mockResolvedValue('data:image/png;base64,resized');

    const result = service.loadPhoto(1);
    input.dispatchEvent(new Event('change'));

    await expect(result).resolves.toEqual(['data:image/png;base64,resized']);
    expect(resize).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/));
  });

  it('rejects browser loading when resizing the selected image fails', async () => {
    isPlatform.mockReturnValue(false);
    const input = document.createElement('input');
    input.id = 'browserPhotoUploader';
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['image'], 'photo.png', { type: 'image/png' })],
    });
    document.body.append(input);
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    const resizeError = new Error('resize failed');
    vi.spyOn(service as unknown as { loadPhotoFromFilePath(path: string): Promise<string> }, 'loadPhotoFromFilePath').mockRejectedValue(
      resizeError,
    );

    const result = service.loadPhoto(1);
    input.dispatchEvent(new Event('change'));

    await expect(result).rejects.toBe(resizeError);
  });

  it('rejects a non-image browser file without attempting to resize it', async () => {
    isPlatform.mockReturnValue(false);
    const input = document.createElement('input');
    input.id = 'browserPhotoUploader';
    let inputValue = 'selected';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => inputValue,
      set: (value: string) => {
        inputValue = value;
      },
    });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['text'], 'notes.txt', { type: 'text/plain' })],
    });
    document.body.append(input);
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    const resize = vi.spyOn(service as unknown as { loadPhotoFromFilePath(path: string): Promise<string> }, 'loadPhotoFromFilePath');

    const result = service.loadPhoto(1);
    input.dispatchEvent(new Event('change'));

    await expect(result).rejects.toBe(PhotoEditorErrors.type);
    expect(resize).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('uses configured labels and rejects a dismissed native source sheet', async () => {
    service.labels = {
      camera: 'Take photo',
      album: 'Choose photo',
      cancel: 'Close',
    };

    await expect(service.loadPhoto(2)).rejects.toBe(PhotoEditorErrors.cancel);
    expect(actionSheetOptions?.buttons.map(({ text, role }) => ({ text, role }))).toEqual([
      { text: 'Take photo', role: undefined },
      { text: 'Choose photo', role: undefined },
      { text: 'Close', role: 'cancel' },
    ]);
  });

  it('returns a camera data URL and passes the configured maximum size', async () => {
    dismissData = 'camera';
    service.photoMaxSize = 2048;
    getPhoto.mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,camera',
      format: 'jpeg',
      saved: false,
    });

    await expect(service.loadPhoto(1)).resolves.toEqual(['data:image/jpeg;base64,camera']);
    expect(getPhoto).toHaveBeenCalledWith({
      quality: 100,
      width: 2048,
      allowEditing: false,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Camera,
      presentationStyle: 'popover',
    });
  });

  it('rejects when native camera capture does not return a data URL', async () => {
    dismissData = 'camera';
    getPhoto.mockRejectedValue(new Error('camera unavailable'));

    await expect(service.loadPhoto(1)).rejects.toBe(PhotoEditorErrors.cancel);
  });

  it('loads every selected album path and preserves selection order', async () => {
    dismissData = 'album';
    pickImages.mockResolvedValue({
      photos: [
        { webPath: 'file://first', format: 'jpeg' },
        { webPath: 'file://second', format: 'png' },
      ],
    });
    const loadPhotoFromFilePath = vi
      .spyOn(service as unknown as { loadPhotoFromFilePath(path: string): Promise<string> }, 'loadPhotoFromFilePath')
      .mockImplementation(async (path) => `resized:${path}`);

    await expect(service.loadPhoto(2)).resolves.toEqual(['resized:file://first', 'resized:file://second']);
    expect(pickImages).toHaveBeenCalledWith({
      quality: 100,
      width: 1000,
      limit: 2,
      presentationStyle: 'popover',
    });
    expect(loadPhotoFromFilePath).toHaveBeenCalledTimes(2);
  });

  it('scales the longest image edge to the configured maximum and destroys the editor', async () => {
    service.photoMaxSize = 1200;
    const editor = {
      destroy: vi.fn(),
      loadImageFromFile: vi.fn().mockResolvedValue({ newWidth: 4800, newHeight: 3200 }),
      toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,resized'),
    };
    vi.mocked(ImageEditor).mockImplementation(function MockImageEditor() {
      return editor as never;
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' })),
    } as never);

    const result = await (service as unknown as { loadPhotoFromFilePath(path: string): Promise<string> }).loadPhotoFromFilePath(
      'file://large-image',
    );

    expect(result).toBe('data:image/jpeg;base64,resized');
    expect(editor.toDataURL).toHaveBeenCalledWith({ multiplier: 0.25 });
    expect(editor.destroy).toHaveBeenCalledOnce();
  });
});
