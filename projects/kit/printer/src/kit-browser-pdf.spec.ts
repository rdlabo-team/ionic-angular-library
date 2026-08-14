import { describe, expect, it, vi } from 'vitest';

import type { KitBrowserPdfDependencies } from './kit-browser-pdf';
import { kitDownloadPdf, kitPreviewGeneratedPdf } from './kit-browser-pdf';

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
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      cleanup = callback;
      return 1;
    }) as typeof globalThis.setTimeout);
    const dependencies: KitBrowserPdfDependencies = {
      ...harness.dependencies,
      schedule: () => {
        throw new Error('schedule failed');
      },
    };

    try {
      expect(() => kitDownloadPdf(Uint8Array.from([1]), { filename: 'label.pdf', dependencies })).not.toThrow();
      expect(harness.click).toHaveBeenCalledOnce();
      cleanup?.();
      expect(harness.remove).toHaveBeenCalledOnce();
      expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe('kitPreviewGeneratedPdf', () => {
  it('opens the placeholder synchronously and replaces it with the generated PDF', async () => {
    const replace = vi.fn();
    const target = {
      closed: false,
      close: vi.fn(),
      document: { title: '', body: { textContent: '' } },
      location: { replace },
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

    expect(harness.open).toHaveBeenCalledWith('', '_blank');
    expect(target.opener).toBeNull();
    expect(target.document.title).toBe('PDF generating');
    expect(target.document.body.textContent).toBe('Please wait');

    resolvePdf(Uint8Array.from([1, 2, 3]));
    await preview;
    expect(replace).toHaveBeenCalledWith('blob:generated-pdf');
    expect(harness.click).not.toHaveBeenCalled();

    harness.scheduled[0]();
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:generated-pdf');
  });

  it('downloads when the preview window is blocked', async () => {
    const harness = createHarness(null);
    await kitPreviewGeneratedPdf(async () => Uint8Array.from([1, 2, 3]), {
      title: 'PDF generating',
      pendingText: 'Please wait',
      fallbackFilename: 'document.pdf',
      dependencies: harness.dependencies,
    });

    expect(harness.link.download).toBe('document.pdf');
    expect(harness.click).toHaveBeenCalledOnce();
  });

  it('downloads when the user closes the preview while the PDF is generating', async () => {
    const target = {
      closed: true,
      close: vi.fn(),
      document: { title: '', body: { textContent: '' } },
      location: { replace: vi.fn() },
      opener: null,
    } as unknown as Window;
    const harness = createHarness(target);

    await kitPreviewGeneratedPdf(async () => Uint8Array.from([1, 2, 3]), {
      title: 'PDF generating',
      pendingText: 'Please wait',
      fallbackFilename: 'document.pdf',
      dependencies: harness.dependencies,
    });

    expect(harness.link.download).toBe('document.pdf');
    expect(harness.click).toHaveBeenCalledOnce();
  });

  it('closes the placeholder and rethrows after generation fails', async () => {
    const close = vi.fn();
    const target = {
      closed: false,
      close,
      document: { title: '', body: { textContent: '' } },
      location: { replace: vi.fn() },
      opener: null,
    } as unknown as Window;
    const harness = createHarness(target);

    const failure = new Error('PDF failed');
    await expect(
      kitPreviewGeneratedPdf(async () => Promise.reject(failure), {
        title: 'PDF generating',
        pendingText: 'Please wait',
        fallbackFilename: 'document.pdf',
        dependencies: harness.dependencies,
      }),
    ).rejects.toBe(failure);

    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves the generation error when closing the placeholder fails', async () => {
    const target = {
      closed: false,
      close: () => {
        throw new Error('close failed');
      },
      document: { title: '', body: { textContent: '' } },
      location: { replace: vi.fn() },
      opener: null,
    } as unknown as Window;
    const harness = createHarness(target);
    const failure = new Error('PDF failed');

    await expect(
      kitPreviewGeneratedPdf(async () => Promise.reject(failure), {
        title: 'PDF generating',
        pendingText: 'Please wait',
        fallbackFilename: 'document.pdf',
        dependencies: harness.dependencies,
      }),
    ).rejects.toBe(failure);
  });

  it('preserves the generation error when reading the closed state fails', async () => {
    const target = {
      get closed(): boolean {
        throw new Error('closed state failed');
      },
      close: vi.fn(),
      document: { title: '', body: { textContent: '' } },
      location: { replace: vi.fn() },
      opener: null,
    } as unknown as Window;
    const harness = createHarness(target);
    const failure = new Error('PDF failed');

    await expect(
      kitPreviewGeneratedPdf(async () => Promise.reject(failure), {
        title: 'PDF generating',
        pendingText: 'Please wait',
        fallbackFilename: 'document.pdf',
        dependencies: harness.dependencies,
      }),
    ).rejects.toBe(failure);
  });

  it('closes an unusable placeholder and downloads the completed PDF', async () => {
    const close = vi.fn();
    const pendingBody = {
      set textContent(_value: string) {
        throw new Error('placeholder failed');
      },
    };
    const target = {
      closed: false,
      close,
      document: { title: '', body: pendingBody },
      location: { replace: vi.fn() },
      opener: null,
    } as unknown as Window;
    const harness = createHarness(target);

    await kitPreviewGeneratedPdf(async () => Uint8Array.from([1]), {
      title: 'PDF generating',
      pendingText: 'Please wait',
      fallbackFilename: 'document.pdf',
      dependencies: harness.dependencies,
    });

    expect(close).toHaveBeenCalledOnce();
    expect(harness.link.download).toBe('document.pdf');
    expect(harness.click).toHaveBeenCalledOnce();
  });

  it('does not misclassify cleanup scheduling failure as PDF generation failure', async () => {
    const replace = vi.fn();
    const target = {
      closed: false,
      close: vi.fn(),
      document: { title: '', body: { textContent: '' } },
      location: { replace },
      opener: null,
    } as unknown as Window;
    const harness = createHarness(target);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => 1) as typeof globalThis.setTimeout);
    const dependencies: KitBrowserPdfDependencies = {
      ...harness.dependencies,
      schedule: () => {
        throw new Error('schedule failed');
      },
    };

    try {
      await expect(
        kitPreviewGeneratedPdf(async () => Uint8Array.from([1]), {
          title: 'PDF generating',
          pendingText: 'Please wait',
          fallbackFilename: 'document.pdf',
          dependencies,
        }),
      ).resolves.toBeUndefined();
      expect(replace).toHaveBeenCalledWith('blob:generated-pdf');
      expect(target.close).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('downloads when navigating the prepared preview fails', async () => {
    const close = vi.fn();
    const target = {
      closed: false,
      close,
      document: { title: '', body: { textContent: '' } },
      location: {
        replace: () => {
          throw new Error('navigation failed');
        },
      },
      opener: null,
    } as unknown as Window;
    const harness = createHarness(target);

    await kitPreviewGeneratedPdf(async () => Uint8Array.from([1]), {
      title: 'PDF generating',
      pendingText: 'Please wait',
      fallbackFilename: 'document.pdf',
      dependencies: harness.dependencies,
    });

    expect(close).toHaveBeenCalledOnce();
    expect(harness.link.download).toBe('document.pdf');
    expect(harness.click).toHaveBeenCalledOnce();
  });
});
