/** Browser dependencies used by the PDF output helpers. */
export interface KitBrowserPdfDependencies {
  /** Document used to create download links and preview windows. */
  readonly document: Pick<Document, 'body' | 'createElement' | 'defaultView'>;
  /** Object URL implementation used for generated PDF blobs. */
  readonly url: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  /** Scheduler used to delay DOM and object URL cleanup. */
  readonly schedule: (callback: () => void, delay: number) => unknown;
}

/** Options shared by browser PDF output helpers. */
export interface KitBrowserPdfOutputOptions {
  /** Delay before temporary resources are released. Invalid values fall back to 60 seconds. */
  readonly cleanupDelayMs?: number;
  /** Browser dependencies. Override in tests; production callers normally omit this. */
  readonly dependencies?: KitBrowserPdfDependencies;
}

/** Options for {@link kitDownloadPdf}. */
export interface KitDownloadPdfOptions extends KitBrowserPdfOutputOptions {
  /** Filename presented by the browser download. */
  readonly filename: string;
}

/** Options for {@link kitPreviewGeneratedPdf}. */
export interface KitPreviewGeneratedPdfOptions extends KitBrowserPdfOutputOptions {
  /** Title shown while the PDF is being generated. */
  readonly title: string;
  /** Text shown while the PDF is being generated. */
  readonly pendingText: string;
  /** Filename used when a preview window cannot be opened or has been closed. */
  readonly fallbackFilename: string;
}

interface PdfPreview {
  readonly show: (pdfBytes: Uint8Array) => void;
  readonly close: () => void;
}

const defaultDependencies = (): KitBrowserPdfDependencies => ({
  document,
  url: URL,
  schedule: (callback, delay) => globalThis.setTimeout(callback, delay),
});

const createPdfUrl = (pdfBytes: Uint8Array, dependencies: KitBrowserPdfDependencies): string =>
  dependencies.url.createObjectURL(
    new Blob([Uint8Array.from(pdfBytes).buffer], {
      type: 'application/pdf',
    }),
  );

const cleanupDelay = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) && value >= 0 ? value : 60_000);

const createCleanup = (pdfUrl: string, dependencies: KitBrowserPdfDependencies, link?: HTMLAnchorElement): (() => void) => {
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      link?.remove();
    } catch {
      // Cleanup is best-effort and must not turn successful PDF output into a failure.
    } finally {
      try {
        dependencies.url.revokeObjectURL(pdfUrl);
      } catch {
        // Object URL cleanup is best-effort for the same reason.
      }
    }
  };
};

const scheduleCleanup = (cleanup: () => void, delay: number, dependencies: KitBrowserPdfDependencies): boolean => {
  try {
    dependencies.schedule(cleanup, delay);
    return true;
  } catch {
    try {
      globalThis.setTimeout(cleanup, delay);
      return true;
    } catch {
      return false;
    }
  }
};

const isWindowClosed = (target: Window): boolean => {
  try {
    return target.closed;
  } catch {
    return true;
  }
};

const closeWindow = (target: Window | null): void => {
  try {
    if (target && !target.closed) target.close();
  } catch {
    // Closing a placeholder is best-effort and must never replace the original output error.
  }
};

/**
 * Download generated PDF bytes without navigating the current application page.
 *
 * @remarks Browser-only. Do not call during server-side rendering.
 *
 * The temporary anchor and object URL stay alive long enough for browsers to start the download.
 * Cleanup is registered before clicking so a cleanup scheduling error cannot be mistaken for a PDF
 * generation failure after the download has already started.
 */
export const kitDownloadPdf = (pdfBytes: Uint8Array, options: KitDownloadPdfOptions): void => {
  const dependencies = options.dependencies ?? defaultDependencies();
  const pdfUrl = createPdfUrl(pdfBytes, dependencies);
  let link: HTMLAnchorElement | undefined;
  let cleanup = createCleanup(pdfUrl, dependencies);
  let cleanupScheduled = false;

  try {
    link = dependencies.document.createElement('a');
    cleanup = createCleanup(pdfUrl, dependencies, link);
    link.href = pdfUrl;
    link.download = options.filename;
    link.style.display = 'none';
    dependencies.document.body.appendChild(link);
    cleanupScheduled = scheduleCleanup(cleanup, cleanupDelay(options.cleanupDelayMs), dependencies);

    // Keep this as the final synchronous output operation: the browser may start immediately.
    link.click();
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    if (!cleanupScheduled) cleanup();
  }
};

/**
 * Open a placeholder window synchronously for an asynchronously generated PDF.
 *
 * Call this directly from the user's click handler, before awaiting PDF generation, to avoid popup
 * blocking. If the preview cannot be opened or is closed while generating, showing the PDF safely
 * falls back to a file download and keeps the current application page in place.
 */
const preparePdfPreview = (options: KitPreviewGeneratedPdfOptions): PdfPreview => {
  const dependencies = options.dependencies ?? defaultDependencies();
  let target: Window | null = null;

  try {
    target = dependencies.document.defaultView?.open('', '_blank') ?? null;
    if (target) {
      target.opener = null;
      target.document.title = options.title;
      target.document.body.textContent = options.pendingText;
    }
  } catch {
    closeWindow(target);
    target = null;
  }

  return {
    show: (pdfBytes): void => {
      if (!target || isWindowClosed(target)) {
        kitDownloadPdf(pdfBytes, {
          filename: options.fallbackFilename,
          cleanupDelayMs: options.cleanupDelayMs,
          dependencies,
        });
        return;
      }

      const pdfUrl = createPdfUrl(pdfBytes, dependencies);
      const cleanup = createCleanup(pdfUrl, dependencies);
      const cleanupScheduled = scheduleCleanup(cleanup, cleanupDelay(options.cleanupDelayMs), dependencies);
      try {
        target.location.replace(pdfUrl);
      } catch {
        cleanup();
        closeWindow(target);
        kitDownloadPdf(pdfBytes, {
          filename: options.fallbackFilename,
          cleanupDelayMs: options.cleanupDelayMs,
          dependencies,
        });
        return;
      } finally {
        if (!cleanupScheduled) cleanup();
      }
    },
    close: (): void => closeWindow(target),
  };
};

/**
 * Preview an asynchronously generated PDF without risking a popup-blocked result.
 *
 * This function opens its placeholder window synchronously, before invoking `buildPdf`. Call it
 * directly from the user's click handler and pass PDF generation as the callback. Generation errors
 * close the placeholder and are rethrown for the application to present with its own UI.
 */
export const kitPreviewGeneratedPdf = async (
  buildPdf: () => Promise<Uint8Array>,
  options: KitPreviewGeneratedPdfOptions,
): Promise<void> => {
  const preview = preparePdfPreview(options);
  try {
    preview.show(await buildPdf());
  } catch (error) {
    preview.close();
    throw error;
  }
};
