import { PDFDocument } from 'pdf-lib';

import { kitBuildLabelPdf, kitCalculatePrintLayout, kitPrintPaperSizes } from './kit-pdf-printer';

describe('kitCalculatePrintLayout', () => {
  it('uses A4 dimensions and the default 5mm margin', () => {
    const layout = kitCalculatePrintLayout({
      paper: kitPrintPaperSizes.a4,
      labelWidthPx: 200,
      labelHeightPx: 100,
      copies: 1,
    });
    expect(layout.paperWidth).toBeCloseTo((210 * 72) / 25.4);
    expect(layout.paperHeight).toBeCloseTo((297 * 72) / 25.4);
    expect(layout.positions[0].x).toBeCloseTo((5 * 72) / 25.4);
  });

  it('supports B5 and continues labels onto additional pages', () => {
    const layout = kitCalculatePrintLayout({
      paper: kitPrintPaperSizes.b5,
      labelWidthPx: 600,
      labelHeightPx: 900,
      copies: 3,
    });
    expect(layout.paperWidth).toBeCloseTo((182 * 72) / 25.4);
    expect(layout.positions.at(-1)?.pageIndex).toBeGreaterThan(0);
  });

  it('applies a physical width while preserving the aspect ratio', () => {
    const layout = kitCalculatePrintLayout({
      paper: kitPrintPaperSizes.a4,
      labelWidthPx: 200,
      labelHeightPx: 100,
      copies: 1,
      measure: { type: 'width', sizeMm: 80 },
    });
    expect(layout.labelWidth).toBeCloseTo((80 * 72) / 25.4);
    expect(layout.labelWidth / layout.labelHeight).toBeCloseTo(2);
  });
});

describe('kitBuildLabelPdf', () => {
  it('builds a PDF containing the required number of pages', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bytes = await kitBuildLabelPdf({
      imageData: png,
      paper: kitPrintPaperSizes.a4,
      labelWidthPx: 600,
      labelHeightPx: 900,
      copies: 2,
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
  });
});
