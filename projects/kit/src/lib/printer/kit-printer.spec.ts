import type { BRLMPrinterLabelName, BRLMPrinterModelName } from '@rdlabo/capacitor-brotherprint';

import { kitBuildBrotherPrintSettings, kitDomToPng, kitRotationImage } from './kit-printer';

// BRLMPrintOptions is a QL|TD union; view the built settings as a flat shape for assertions.
const asRecord = (s: unknown) =>
  s as { tapeWidth: number; tapeLength: number; encodedImage: string; numberOfCopies: number; halftoneThreshold: number };

const getPlatform = vi.fn();
const toPng = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => getPlatform() },
}));

vi.mock('dom-to-image-more', () => ({
  default: { toPng: (...args: unknown[]) => toPng(...args) },
}));

// Enums are referenced by identity in the built settings, so plain sentinels are enough.
vi.mock('@rdlabo/capacitor-brotherprint', () => ({
  BRLMPrinterScaleMode: { FitPageAspect: 'FitPageAspect' },
  BRLMPrinterImageRotation: { Rotate0: 'Rotate0' },
  BRLMPrinterVerticalAlignment: { Center: 'V-Center' },
  BRLMPrinterHorizontalAlignment: { Center: 'H-Center' },
  BRLMPrinterPrintQuality: { Best: 'Best' },
  BRLMPrinterCustomPaperType: { dieCutPaper: 'dieCutPaper' },
  BRLMPrinterCustomPaperUnit: { mm: 'mm' },
  BRLMPrinterHalftone: { Threshold: 'Threshold' },
}));

describe('kitBuildBrotherPrintSettings', () => {
  const base = {
    modelName: 'QL-820NWB' as BRLMPrinterModelName,
    printBase64: 'data:image/png;base64,AAABBB',
    label: 'RDDieCutW50H35' as BRLMPrinterLabelName,
    numberOfCopies: 2,
    halftoneThreshold: 128,
  };

  it('derives tape dimensions from the label WxH code', () => {
    const s = asRecord(kitBuildBrotherPrintSettings(base));
    expect(s.tapeWidth).toBe(50);
    expect(s.tapeLength).toBe(35);
  });

  it('strips the data-URL prefix from the encoded image', () => {
    const s = asRecord(kitBuildBrotherPrintSettings(base));
    expect(s.encodedImage).toBe('AAABBB');
  });

  it('passes copies and halftone threshold through', () => {
    const s = asRecord(kitBuildBrotherPrintSettings({ ...base, numberOfCopies: 5, halftoneThreshold: 200 }));
    expect(s.numberOfCopies).toBe(5);
    expect(s.halftoneThreshold).toBe(200);
  });

  it('applies the canonical fixed settings (margins, autoCut, gap)', () => {
    const s = asRecord(kitBuildBrotherPrintSettings(base));
    expect(s).toMatchObject({
      autoCut: true,
      gapLength: 2.0,
      marginTop: 1.0,
      marginRight: 2.0,
      marginBottom: 1.0,
      marginLeft: 2.0,
      labelName: 'RDDieCutW50H35',
    });
  });

  it('falls back to zero tape size when the label has no WxH code', () => {
    const s = asRecord(kitBuildBrotherPrintSettings({ ...base, label: 'General' as BRLMPrinterLabelName }));
    expect(s.tapeWidth).toBe(0);
    expect(s.tapeLength).toBe(0);
  });
});

describe('kitDomToPng', () => {
  function el(w = 100, h = 40) {
    const node = document.createElement('div');
    Object.defineProperty(node, 'clientWidth', { value: w });
    Object.defineProperty(node, 'clientHeight', { value: h });
    return node;
  }

  afterEach(() => vi.clearAllMocks());

  it('pads width/height by 2px on iOS', async () => {
    getPlatform.mockReturnValue('ios');
    toPng.mockResolvedValue('data:image/png;base64,IOS');
    const out = await kitDomToPng(el(100, 40));
    expect(out).toBe('data:image/png;base64,IOS');
    expect(toPng).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ width: 102, height: 42, scale: 3 }));
  });

  it('does not pad on Android', async () => {
    getPlatform.mockReturnValue('android');
    toPng.mockResolvedValue('x');
    await kitDomToPng(el(100, 40));
    expect(toPng).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ width: 100, height: 40 }));
  });

  it('retries until a non-empty result, returning empty after 10 misses', async () => {
    getPlatform.mockReturnValue('android');
    toPng.mockResolvedValue('');
    const out = await kitDomToPng(el());
    expect(out).toBe('');
    expect(toPng).toHaveBeenCalledTimes(10);
  });

  it('rotates the result when rotate is set', async () => {
    getPlatform.mockReturnValue('android');
    toPng.mockResolvedValue('data:image/png;base64,ZZZ');
    // Fake canvas + Image so rotation runs without a real 2d context.
    const ctx = { rotate: vi.fn(), translate: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,ROTATED' };
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas' ? canvas : ({} as unknown)) as typeof document.createElement);
    vi.stubGlobal(
      'Image',
      class {
        width = 20;
        height = 10;
        onload: (() => void) | null = null;
        set src(_v: string) {
          setTimeout(() => this.onload?.());
        }
      },
    );
    const out = await kitDomToPng(el(), { rotate: true });
    expect(out).toBe('data:image/png;base64,ROTATED');
    expect(ctx.drawImage).toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe('kitRotationImage', () => {
  it('swaps canvas dimensions and returns the rotated data URL', async () => {
    const ctx = { rotate: vi.fn(), translate: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: (t: string) => `rotated:${t}` };
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas' ? canvas : ({} as unknown)) as typeof document.createElement);
    vi.stubGlobal(
      'Image',
      class {
        width = 20;
        height = 10;
        onload: (() => void) | null = null;
        set src(_v: string) {
          setTimeout(() => this.onload?.());
        }
      },
    );

    const out = await kitRotationImage('data:image/png;base64,ABC');
    expect(out).toBe('rotated:image/png');
    expect(canvas.width).toBe(10); // image.height
    expect(canvas.height).toBe(20); // image.width
    expect(ctx.rotate).toHaveBeenCalledWith((90 * Math.PI) / 180);

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
