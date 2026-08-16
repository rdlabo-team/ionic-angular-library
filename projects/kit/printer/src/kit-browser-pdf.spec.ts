import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KitBrowserPdfDependencies } from './kit-browser-pdf';
import { kitDownloadPdf, kitPreviewGeneratedPdf } from './kit-browser-pdf';

afterEach(() => vi.restoreAllMocks());

interface BrowserPdfTestHarness {
  readonly dependencies: KitBrowserPdfDependencies;
  readonly link: HTMLAnchorElement;
  readonly appendChild: ReturnType<typeof vi.fn>;
  readonly click: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
  readonly createObjectURL: ReturnType<typeof vi.fn>;
  readonly revokeObjectURL: ReturnType<typeof vi.fn>;
  readonly scheduled: (() => void)[];
  readonly open: ReturnType<typeof vi.fn>;
}

const createHarness = (target: Window | null = null): BrowserPdfTestHarness => {
  const click = vi.fn();
  const remove = vi.fn();
  const appendChild = vi.fn();
  const link = { href: '', download: '', style: { display: '' }, click, remove } as unknown as HTMLAnchorElement;
  const createObjectURL = vi.fn(() => 'blob:generated-pdf');
  const revokeObjectURL = vi.fn();
  const scheduled: (() => void)[] = [];
  const open = vi.fn(() => target);

  return {
    dependencies: {
      document: {
        body: { appendChild } as unknown as HTMLElement,
        createElement: vi.fn(() => link),
        defaultView: { open } as unknown as Window & typeof globalThis,
      },
      url: { createObjectURL, revokeObjectURL },
      schedule: (callback) => scheduled.push(callback),
    },
    link,
    appendChild,
    click,
    remove,
    createObjectURL,
    revokeObjectURL,
    scheduled,
    open,
  };
};

describe('kitDownloadPdf', () => {
  it('downloads without navigating and cleans up after the browser has started', () => {
    const harness = createHarness();

    kitDownloadPdf(Uint8Array.from([1, 2, 3]), {
      filename: 'label.pdf',
      dependencies: harness.dependencies,
    });

    expect(harness.link.href).toBe('blob:generated-pdf');
    expect(harness.link.download).toBe('label.pdf');
    expect(harness.appendChild).toHaveBeenCalledWith(harness.link);
    expect(harness.click).toHaveBeenCalledOnce();
    expect(harness.remove).not.toHaveBeenCalled();

    harness.scheduled[0]();
    expect(harness.remove).toHaveBeenCalledOnce();
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
  });

  it('revokes the object URL when creating the download link fails', () => {
    const harness = createHarness();
    const failure = new Error('createElement failed');
    const dependencies: KitBrowserPdfDependencies = {
      ...harness.dependencies,
      document: {
        ...harness.dependencies.document,
        createElement: () => {
          throw failure;
        },
      },
    };

    expect(() => kitDownloadPdf(Uint8Array.from([1]), { filename: 'label.pdf', dependencies })).toThrow(failure);
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
  });

  it('removes the link and revokes the object URL when appending fails', () => {
    const harness = createHarness();
    const failure = new Error('append failed');
    harness.appendChild.mockImplementation(() => {
      throw failure;
    });

    expect(() =>
      kitDownloadPdf(Uint8Array.from([1]), {
        filename: 'label.pdf',
        dependencies: harness.dependencies,
      }),
    ).toThrow(failure);
    expect(harness.remove).toHaveBeenCalledOnce();
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
  });

  it('still revokes the object URL when removing the temporary link fails', () => {
    const harness = createHarness();
    harness.remove.mockImplementation(() => {
      throw new Error('remove failed');
    });

    kitDownloadPdf(Uint8Array.from([1]), {
      filename: 'label.pdf',
      dependencies: harness.dependencies,
    });
    expect(() => harness.scheduled[0]()).not.toThrow();
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
  });

  it('uses the global scheduler when the injected scheduler fails', () => {
    const harness = createHarness();
    let cleanup: (() => void) | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      cleanup = callback;
      return 1;
    }) as typeof globalThis.setTimeout);
    const dependencies: KitBrowserPdfDependencies = {
      ...harness.dependencies,
      schedule: () => {
        throw new Error('schedule failed');
      },
    };

    expect(() => kitDownloadPdf(Uint8Array.from([1]), { filename: 'label.pdf', dependencies })).not.toThrow();
    expect(harness.click).toHaveBeenCalledOnce();
    cleanup?.();
    expect(harness.remove).toHaveBeenCalledOnce();
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
  });
});

describe('kitPreviewGeneratedPdf', () => {
  it('does not open until buildPdf resolves, then opens the completed blob URL', async () => {
    const target = {
      closed: false,
      close: vi.fn(),
      opener: {} as Window,
    } as unknown as Window;
    const harness = createHarness(target);

    let resolvePdf!: (bytes: Uint8Array) => void;
    const buildPdf = vi.fn(() => new Promise<Uint8Array>((resolve) => (resolvePdf = resolve)));
    const preview = kitPreviewGeneratedPdf(buildPdf, {
      title: 'PDF generating',
      pendingText: 'Please wait',
      fallbackFilename: 'document.pdf',
      dependencies: harness.dependencies,
    });

    expect(buildPdf).toHaveBeenCalledOnce();
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.createObjectURL).not.toHaveBeenCalled();

    resolvePdf(Uint8Array.from([1, 2, 3]));
    await preview;

    expect(harness.createObjectURL).toHaveBeenCalledOnce();
    expect(harness.open).toHaveBeenCalledWith('blob:generated-pdf', '_blank');
    expect(target.opener).toBeNull();
    expect(harness.click).not.toHaveBeenCalled();

    harness.scheduled[0]();
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
  });

  it('downloads when the preview window is blocked', async () => {
    const harness = createHarness(null);
    await kitPreviewGeneratedPdf(async () => Uint8Array.from([1, 2, 3]), {
      fallbackFilename: 'document.pdf',
      dependencies: harness.dependencies,
    });

    expect(harness.open).toHaveBeenCalledWith('blob:generated-pdf', '_blank');
    expect(harness.link.download).toBe('document.pdf');
    expect(harness.click).toHaveBeenCalledOnce();
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
  });

  it('downloads when opening the preview throws', async () => {
    const harness = createHarness();
    harness.open.mockImplementation(() => {
      throw new Error('popup blocked');
    });

    await kitPreviewGeneratedPdf(async () => Uint8Array.from([1, 2, 3]), {
      fallbackFilename: 'document.pdf',
      dependencies: harness.dependencies,
    });

    expect(harness.link.download).toBe('document.pdf');
    expect(harness.click).toHaveBeenCalledOnce();
  });

  it('closes a partially opened window and downloads when isolating the opener fails', async () => {
    const close = vi.fn();
    const target = {
      closed: false,
      close,
      set opener(_value: Window | null) {
        throw new Error('opener isolation failed');
      },
    } as unknown as Window;
    const harness = createHarness(target);

    await kitPreviewGeneratedPdf(async () => Uint8Array.from([1]), {
      fallbackFilename: 'document.pdf',
      dependencies: harness.dependencies,
    });

    expect(close).toHaveBeenCalledOnce();
    expect(harness.link.download).toBe('document.pdf');
    expect(harness.click).toHaveBeenCalledOnce();
  });

  it('rethrows after generation fails without opening a preview', async () => {
    const harness = createHarness({
      closed: false,
      close: vi.fn(),
      opener: null,
    } as unknown as Window);
    const failure = new Error('PDF failed');

    await expect(
      kitPreviewGeneratedPdf(async () => Promise.reject(failure), {
        fallbackFilename: 'document.pdf',
        dependencies: harness.dependencies,
      }),
    ).rejects.toBe(failure);

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.createObjectURL).not.toHaveBeenCalled();
    expect(harness.click).not.toHaveBeenCalled();
  });

  it('does not misclassify cleanup scheduling failure as PDF generation failure', async () => {
    const target = {
      closed: false,
      close: vi.fn(),
      opener: null,
    } as unknown as Window;
    const harness = createHarness(target);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => 1) as typeof globalThis.setTimeout);
    const dependencies: KitBrowserPdfDependencies = {
      ...harness.dependencies,
      schedule: () => {
        throw new Error('schedule failed');
      },
    };

    await expect(
      kitPreviewGeneratedPdf(async () => Uint8Array.from([1]), {
        fallbackFilename: 'document.pdf',
        dependencies,
      }),
    ).resolves.toBeUndefined();
    expect(harness.open).toHaveBeenCalledWith('blob:generated-pdf', '_blank');
    expect(target.close).not.toHaveBeenCalled();
  });

  it('propagates download failures after a blocked preview', async () => {
    const harness = createHarness(null);
    const failure = new Error('download failed');
    harness.appendChild.mockImplementation(() => {
      throw failure;
    });

    await expect(
      kitPreviewGeneratedPdf(async () => Uint8Array.from([1]), {
        fallbackFilename: 'document.pdf',
        dependencies: harness.dependencies,
      }),
    ).rejects.toBe(failure);
  });
});
