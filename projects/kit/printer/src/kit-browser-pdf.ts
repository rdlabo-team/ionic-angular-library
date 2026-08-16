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
  /**
   * Previously used as the placeholder tab title while PDF generation was in progress.
   *
   * @deprecated No placeholder window is shown; this option is ignored. Kept for source compatibility.
   */
  readonly title?: string;
  /**
   * Previously used as the placeholder tab body text while PDF generation was in progress.
   *
   * @deprecated No placeholder window is shown; this option is ignored. Kept for source compatibility.
   */
  readonly pendingText?: string;
  /** Filename used when a preview window cannot be opened. */
  readonly fallbackFilename: string;
}

interface DownloadResource {
  link?: HTMLAnchorElement;
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

const createCleanup = (pdfUrl: string, dependencies: KitBrowserPdfDependencies, resource?: DownloadResource): (() => void) => {
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      resource?.link?.remove();
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

const prepareDownloadLink = (
  resource: DownloadResource,
  pdfUrl: string,
  filename: string,
  dependencies: KitBrowserPdfDependencies,
): HTMLAnchorElement => {
  const link = dependencies.document.createElement('a');
  resource.link = link;
  link.href = pdfUrl;
  link.download = filename;
  link.style.display = 'none';
  dependencies.document.body.appendChild(link);
  return link;
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

const clearWindowOpener = (target: Window): void => {
  target.opener = null;
};

const closeWindowIfOpen = (target: Window | null): void => {
  if (target && !target.closed) {
    target.close();
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
  const resource: DownloadResource = {};
  const cleanup = createCleanup(pdfUrl, dependencies, resource);
  let link: HTMLAnchorElement;

  try {
    link = prepareDownloadLink(resource, pdfUrl, options.filename, dependencies);
  } catch (error) {
    cleanup();
    throw error;
  }
  const cleanupScheduled = scheduleCleanup(cleanup, cleanupDelay(options.cleanupDelayMs), dependencies);
  try {
    link.click();
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    if (!cleanupScheduled) cleanup();
  }
};

/**
 * Preview an asynchronously generated PDF after generation completes in the source tab.
 *
 * `buildPdf` runs to completion while the calling tab stays active so DOM-based builders that rely
 * on `requestAnimationFrame` are not stalled by a backgrounded placeholder tab. The completed PDF
 * object URL is then opened in `_blank`. If opening is blocked or throws, the PDF is downloaded
 * instead and the current application page stays in place. Generation errors are rethrown for the
 * application to present with its own UI.
 *
 * @remarks Browser-only. Do not call during server-side rendering. Call from a user gesture when
 * possible; after an `await`, browsers may still block the preview window and trigger the download
 * fallback.
 */
export const kitPreviewGeneratedPdf = async (
  buildPdf: () => Promise<Uint8Array>,
  options: KitPreviewGeneratedPdfOptions,
): Promise<void> => {
  const dependencies = options.dependencies ?? defaultDependencies();
  const pdfBytes = await buildPdf();
  const pdfUrl = createPdfUrl(pdfBytes, dependencies);
  const cleanup = createCleanup(pdfUrl, dependencies);

  let target: Window | null = null;
  try {
    target = dependencies.document.defaultView?.open(pdfUrl, '_blank') ?? null;
    if (target) clearWindowOpener(target);
  } catch {
    try {
      closeWindowIfOpen(target);
    } catch {
      // Closing a partially opened preview is best-effort.
    }
    target = null;
  }

  if (!target) {
    cleanup();
    kitDownloadPdf(pdfBytes, {
      filename: options.fallbackFilename,
      cleanupDelayMs: options.cleanupDelayMs,
      dependencies,
    });
    return;
  }

  const cleanupScheduled = scheduleCleanup(cleanup, cleanupDelay(options.cleanupDelayMs), dependencies);
  if (!cleanupScheduled) {
    cleanup();
  }
};
