import { TestBed } from '@angular/core/testing';
import { ActionSheetController, Platform } from '@ionic/angular';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { vi } from 'vitest';

import { providePhotoEditor } from '@rdlabo/ionic-angular-photo-editor';
import { PhotoFileService } from '../../file/src/lib/photo-file.service';
import { loadCapacitorPhotoCamera } from '../../file/capacitor/src/public-api';

vi.mock('@capacitor/camera', () => ({
  Camera: {
    getPhoto: vi.fn(),
    pickImages: vi.fn(),
  },
  CameraResultType: { DataUrl: 'dataUrl' },
  CameraSource: { Camera: 'CAMERA' },
}));

interface EditorAdapter {
  destroy: ReturnType<typeof vi.fn>;
  loadImageFromFile: ReturnType<typeof vi.fn>;
  toDataURL: ReturnType<typeof vi.fn>;
}

const createAdapter = (value = 'data:image/png;base64,resized'): EditorAdapter => ({
  destroy: vi.fn(),
  loadImageFromFile: vi.fn().mockResolvedValue({ newWidth: 2400, newHeight: 1200 }),
  toDataURL: vi.fn().mockReturnValue(value),
});

describe('PhotoFileService', () => {
  let service: PhotoFileService;
  let isPlatform: ReturnType<typeof vi.fn>;
  let createActionSheet: ReturnType<typeof vi.fn>;
  let createImageEditor: ReturnType<typeof vi.fn>;
  let getPhoto: ReturnType<typeof vi.fn>;
  let pickImages: ReturnType<typeof vi.fn>;
  let adapter: EditorAdapter;
  let dismissData: 'camera' | 'album' | undefined;
  let actionSheetOptions: { buttons: { text: string; role?: string; handler?: () => void }[] } | undefined;

  beforeEach(() => {
    dismissData = undefined;
    actionSheetOptions = undefined;
    isPlatform = vi.fn().mockReturnValue(true);
    adapter = createAdapter();
    createImageEditor = vi.fn().mockResolvedValue(adapter);
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
        providePhotoEditor({
          maxPhotoSize: 1200,
          fileLabels: { camera: 'Take photo', album: 'Choose photo', cancel: 'Close' },
          createImageEditor: createImageEditor as never,
          loadCamera: loadCapacitorPhotoCamera,
        }),
      ],
    });
    service = TestBed.inject(PhotoFileService);
  });

  afterEach(() => {
    document.querySelectorAll('input[type="file"]').forEach((input) => input.remove());
    vi.restoreAllMocks();
  });

  const pendingBrowserSelection = (options?: Parameters<PhotoFileService['loadPhoto']>[0]) => {
    isPlatform.mockReturnValue(false);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    const result = service.loadPhoto(options);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    return { input: input!, result };
  };

  const setFiles = (input: HTMLInputElement, files: File[]) => {
    Object.defineProperty(input, 'files', { configurable: true, value: files });
  };

  it('creates a hidden browser input dynamically and removes it after cancellation', async () => {
    const { input, result } = pendingBrowserSelection({ limit: 2 });

    expect(input.accept).toBe('image/*');
    expect(input.multiple).toBe(true);
    expect(input.getAttribute('aria-hidden')).toBe('true');
    expect(input.click).toHaveBeenCalledOnce();

    input.dispatchEvent(new Event('cancel'));

    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(input.isConnected).toBe(false);
  });

  it('cleans up and reports unavailable when the browser picker cannot open', async () => {
    isPlatform.mockReturnValue(false);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {
      throw new Error('picker unavailable');
    });

    await expect(service.loadPhoto()).rejects.toMatchObject({ code: 'unavailable' });

    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('rejects an empty or invalid browser selection and always cleans up the input', async () => {
    const empty = pendingBrowserSelection();
    setFiles(empty.input, []);
    empty.input.dispatchEvent(new Event('change'));
    await expect(empty.result).rejects.toMatchObject({ code: 'cancelled' });
    expect(empty.input.isConnected).toBe(false);

    const invalid = pendingBrowserSelection();
    setFiles(invalid.input, [new File(['text'], 'notes.txt', { type: 'text/plain' })]);
    invalid.input.dispatchEvent(new Event('change'));
    await expect(invalid.result).rejects.toMatchObject({ code: 'invalid-type' });
    expect(invalid.input.isConnected).toBe(false);
    expect(createImageEditor).not.toHaveBeenCalled();
  });

  it('limits browser files and resizes them through the configured adapter', async () => {
    const adapters = [createAdapter('resized:first'), createAdapter('resized:second')];
    createImageEditor.mockImplementation(async () => adapters.shift()!);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
    } as never);
    const { input, result } = pendingBrowserSelection({ limit: 2, maxSize: 600 });
    setFiles(input, [
      new File(['first'], 'first.png', { type: 'image/png' }),
      new File(['second'], 'second.png', { type: 'image/png' }),
      new File(['third'], 'third.png', { type: 'image/png' }),
    ]);

    input.dispatchEvent(new Event('change'));

    await expect(result).resolves.toEqual(['resized:first', 'resized:second']);
    expect(createImageEditor).toHaveBeenCalledTimes(2);
    expect(createImageEditor).toHaveBeenCalledWith(expect.any(HTMLElement), { cssMaxWidth: 600, cssMaxHeight: 600 });
    expect(input.isConnected).toBe(false);
  });

  it('uses configured labels and reports a dismissed native source sheet as cancelled', async () => {
    await expect(service.loadPhoto()).rejects.toMatchObject({ code: 'cancelled' });

    expect(actionSheetOptions?.buttons.map(({ text, role }) => ({ text, role }))).toEqual([
      { text: 'Take photo', role: undefined },
      { text: 'Choose photo', role: undefined },
      { text: 'Close', role: 'cancel' },
    ]);
  });

  it('merges request labels over configured defaults', async () => {
    await expect(service.loadPhoto({ labels: { camera: 'Camera override' } })).rejects.toMatchObject({
      code: 'cancelled',
    });

    expect(actionSheetOptions?.buttons.map(({ text }) => text)).toEqual(['Camera override', 'Choose photo', 'Close']);
  });

  it('returns a camera data URL and applies normalized request options', async () => {
    dismissData = 'camera';
    getPhoto.mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,camera',
      format: 'jpeg',
      saved: false,
    });

    await expect(service.loadPhoto({ limit: 0, maxSize: 2048.9 })).resolves.toEqual(['data:image/jpeg;base64,camera']);
    expect(getPhoto).toHaveBeenCalledWith({
      quality: 100,
      width: 2048,
      allowEditing: false,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Camera,
      presentationStyle: 'popover',
    });
  });

  it('reports unavailable camera capture as cancelled', async () => {
    dismissData = 'camera';
    getPhoto.mockRejectedValue(new Error('camera unavailable'));

    await expect(service.loadPhoto()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('loads album paths in order with the configured maximum size', async () => {
    dismissData = 'album';
    pickImages.mockResolvedValue({
      photos: [
        { webPath: 'file://first', format: 'jpeg' },
        { webPath: 'file://second', format: 'png' },
      ],
    });
    const adapters = [createAdapter('resized:first'), createAdapter('resized:second')];
    createImageEditor.mockImplementation(async () => adapters.shift()!);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' })),
    } as never);

    await expect(service.loadPhoto({ limit: 2 })).resolves.toEqual(['resized:first', 'resized:second']);
    expect(pickImages).toHaveBeenCalledWith({
      quality: 100,
      width: 1200,
      limit: 2,
      presentationStyle: 'popover',
    });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, 'file://first');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, 'file://second');
  });

  it('scales the longest edge and destroys the configured adapter', async () => {
    dismissData = 'album';
    pickImages.mockResolvedValue({ photos: [{ webPath: 'file://large', format: 'jpeg' }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' })),
    } as never);

    await expect(service.loadPhoto({ maxSize: 600 })).resolves.toEqual(['data:image/png;base64,resized']);

    expect(createImageEditor).toHaveBeenCalledWith(expect.any(HTMLElement), { cssMaxWidth: 600, cssMaxHeight: 600 });
    expect(adapter.toDataURL).toHaveBeenCalledWith({ multiplier: 0.25 });
    expect(adapter.destroy).toHaveBeenCalledOnce();
  });

  it('destroys the adapter when loading the source fails', async () => {
    dismissData = 'album';
    pickImages.mockResolvedValue({ photos: [{ webPath: 'file://missing', format: 'jpeg' }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as never);

    await expect(service.loadPhoto()).rejects.toMatchObject({ code: 'unavailable' });
    expect(adapter.destroy).toHaveBeenCalledOnce();
  });

  it('does not upscale an image that is already below the maximum size', async () => {
    dismissData = 'album';
    pickImages.mockResolvedValue({ photos: [{ webPath: 'file://small', format: 'jpeg' }] });
    adapter.loadImageFromFile.mockResolvedValue({ newWidth: 400, newHeight: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' })),
    } as never);

    await service.loadPhoto({ maxSize: 600 });

    expect(adapter.toDataURL).toHaveBeenCalledWith({ multiplier: 1 });
  });
});
