import { PDFDocument } from 'pdf-lib';

/** Physical paper dimensions used to build a PDF page. */
export interface KitPrintPaper {
  /** Human-readable paper name. */
  readonly label: string;
  /** Paper width in millimetres. */
  readonly widthMm: number;
  /** Paper height in millimetres. */
  readonly heightMm: number;
}

/** Standard paper presets shared by the printing applications. */
export const kitPrintPaperSizes = {
  a4: { label: 'A4', widthMm: 210, heightMm: 297 },
  b5: { label: 'B5', widthMm: 182, heightMm: 257 },
} as const satisfies Record<string, KitPrintPaper>;

/** A position for one label on a PDF page, expressed in PDF points. */
export interface KitPrintPosition {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
}

/** Calculated PDF page and label dimensions. */
export interface KitPrintLayout {
  readonly paperWidth: number;
  readonly paperHeight: number;
  readonly labelWidth: number;
  readonly labelHeight: number;
  readonly positions: readonly KitPrintPosition[];
}

/** Optional physical size override for a label. */
export interface KitPrintMeasure {
  readonly type: 'width' | 'height';
  readonly sizeMm: number;
}

/** Parameters for {@link kitCalculatePrintLayout}. */
export interface KitCalculatePrintLayoutParams {
  readonly paper: KitPrintPaper;
  readonly labelWidthPx: number;
  readonly labelHeightPx: number;
  readonly copies: number;
  readonly measure?: KitPrintMeasure | null;
  /** Outer page margin in millimetres. Defaults to 5mm. */
  readonly marginMm?: number;
}

/**
 * Calculate page dimensions and row-major label positions for a printable PDF.
 *
 * Labels keep their aspect ratio, are never enlarged beyond their requested pixel/physical size,
 * and automatically continue on additional pages when the current page is full.
 */
export const kitCalculatePrintLayout = (params: KitCalculatePrintLayoutParams): KitPrintLayout => {
  const pointsPerMm = 72 / 25.4;
  const pointsPerPixel = 72 / 96;
  const paperWidth = params.paper.widthMm * pointsPerMm;
  const paperHeight = params.paper.heightMm * pointsPerMm;
  const margin = (params.marginMm ?? 5) * pointsPerMm;
  const aspect = params.labelWidthPx / params.labelHeightPx;
  let labelWidth = params.labelWidthPx * pointsPerPixel;
  let labelHeight = params.labelHeightPx * pointsPerPixel;

  if (params.measure?.type === 'width') {
    labelWidth = params.measure.sizeMm * pointsPerMm;
    labelHeight = labelWidth / aspect;
  } else if (params.measure?.type === 'height') {
    labelHeight = params.measure.sizeMm * pointsPerMm;
    labelWidth = labelHeight * aspect;
  }

  const scale = Math.min(1, (paperWidth - margin * 2) / labelWidth, (paperHeight - margin * 2) / labelHeight);
  labelWidth *= scale;
  labelHeight *= scale;

  const positions: KitPrintPosition[] = [];
  let pageIndex = 0;
  let x = margin;
  let y = paperHeight - margin;
  for (let index = 0; index < Math.max(0, params.copies); index++) {
    if (x + labelWidth > paperWidth - margin + 0.01) {
      x = margin;
      y -= labelHeight;
    }
    if (y - labelHeight < margin - 0.01) {
      pageIndex++;
      x = margin;
      y = paperHeight - margin;
    }
    positions.push({ pageIndex, x, y: y - labelHeight });
    x += labelWidth;
  }

  return { paperWidth, paperHeight, labelWidth, labelHeight, positions };
};

/** Parameters for {@link kitBuildLabelPdf}. */
export interface KitBuildLabelPdfParams extends KitCalculatePrintLayoutParams {
  /** PNG label artwork as a data URL or base64 string accepted by pdf-lib. */
  readonly imageData: string;
}

/** Build a multi-page label PDF and return its bytes without choosing an output destination. */
export const kitBuildLabelPdf = async (params: KitBuildLabelPdfParams): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(params.imageData);
  const layout = kitCalculatePrintLayout(params);
  const pages = layout.positions.length > 0 ? [pdf.addPage([layout.paperWidth, layout.paperHeight])] : [];

  for (const position of layout.positions) {
    while (pages.length <= position.pageIndex) pages.push(pdf.addPage([layout.paperWidth, layout.paperHeight]));
    pages[position.pageIndex].drawImage(image, {
      x: position.x,
      y: position.y,
      width: layout.labelWidth,
      height: layout.labelHeight,
    });
  }

  return pdf.save();
};
