import { Capacitor } from '@capacitor/core';
import type { BRLMPrinterLabelName, BRLMPrinterModelName, BRLMPrintOptions } from '@rdlabo/capacitor-brotherprint';
import {
  BRLMPrinterCustomPaperType,
  BRLMPrinterCustomPaperUnit,
  BRLMPrinterHalftone,
  BRLMPrinterHorizontalAlignment,
  BRLMPrinterImageRotation,
  BRLMPrinterPrintQuality,
  BRLMPrinterScaleMode,
  BRLMPrinterVerticalAlignment,
} from '@rdlabo/capacitor-brotherprint';
import domtoimage from 'dom-to-image-more';

/**
 * Rotate a base64 image 90°, returning a new base64 data URL of the same MIME type.
 *
 * @remarks
 * Pure DOM/canvas work — no DI. Used before sending a label to the printer when the artwork must be
 * turned to match the tape orientation. Extracted verbatim from the fleet's printer services so the
 * canvas handling lives in one place.
 *
 * @param imageData - a base64 data URL (e.g. `data:image/png;base64,...`)
 * @returns a Promise resolving to the rotated image as a base64 data URL
 */
export const kitRotationImage = async (imageData: string): Promise<string> => {
  const imgType = imageData.substring(5, imageData.indexOf(';'));

  const image = new Image();
  const loaded = () =>
    new Promise<void>((resolve) => {
      image.onload = () => resolve();
    });
  setTimeout(() => (image.src = imageData));
  await loaded();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  canvas.width = image.height;
  canvas.height = image.width;

  ctx!.rotate((90 * Math.PI) / 180);
  ctx!.translate(0, -image.height);
  ctx!.drawImage(image, 0, 0, image.width, image.height);

  return canvas.toDataURL(imgType);
};

/** Options for {@link kitDomToPng}. */
export interface KitDomToPngOptions {
  /** When `true`, the rendered PNG is rotated 90° via {@link kitRotationImage}. Defaults to `false`. */
  readonly rotate?: boolean;
  /** Rendering scale passed to `dom-to-image-more`. Defaults to `3` (the fleet's print resolution). */
  readonly scale?: number;
}

/**
 * Render a DOM element to a base64 PNG for label printing, with the fleet's device-specific fixes.
 *
 * @remarks
 * Pure function — no DI (reads the platform from `Capacitor`, uses the global `document`), so the
 * caller presents its own loading UI around it. Centralizes the hard-won device quirks: on iOS it
 * pads width/height by 2px (otherwise the bottom is clipped), on Android it does not (the padding
 * introduces a black line). Retries the `dom-to-image-more` render up to 10 times because the first
 * pass can occasionally return empty. This is exactly the kind of plumbing where a future fix should
 * land in every app at once.
 *
 * @param element - the element to rasterize (e.g. the label preview host)
 * @param options - rendering options; see {@link KitDomToPngOptions}
 * @returns a Promise resolving to the PNG as a base64 data URL (empty string if every attempt failed)
 * @example
 * ```ts
 * const loading = await this.#loadingCtrl.create({ message: this.text.generating });
 * await loading.present();
 * const png = await kitDomToPng(this.preview().nativeElement, { rotate: true });
 * await loading.dismiss();
 * ```
 */
export const kitDomToPng = async (element: HTMLElement, options?: KitDomToPngOptions): Promise<string> => {
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const { clientHeight, clientWidth } = element;

  // デバイス毎の問題解決のため、px 調整。
  // iOS: ないと下が途切れる。Android: あると黒線が入る。
  const addClient = Capacitor.getPlatform() === 'ios' ? 2 : 0;

  const dataUrl: string = await new Promise((resolve) => {
    void (async () => {
      for (let i = 0; i < 10; i++) {
        const url = await domtoimage.toPng(element, {
          width: clientWidth + addClient,
          height: clientHeight + addClient,
          scale: options?.scale ?? 3,
          copyDefaultStyles: false,
        });
        if (url) {
          resolve(url);
          return;
        }
      }
      resolve('');
    })();
  });

  return options?.rotate ? kitRotationImage(dataUrl) : dataUrl;
};

/** Parameters for {@link kitBuildBrotherPrintSettings}. */
export interface KitBrotherPrintSettingsParams {
  /** The target printer model. */
  readonly modelName: BRLMPrinterModelName;
  /** The label artwork as a base64 data URL (the `data:...,` prefix is stripped internally). */
  readonly printBase64: string;
  /** The selected label/paper (its `W<width>H<height>` code drives the tape dimensions). */
  readonly label: BRLMPrinterLabelName;
  /** Number of copies to print. Passed by the caller (apps differ: some use the print option, some fix 1). */
  readonly numberOfCopies: number;
  /** Halftone threshold for the print. */
  readonly halftoneThreshold: number;
}

/**
 * Assemble the Brother `BRLMPrintOptions` for a die-cut label print, minus the transport fields.
 *
 * @remarks
 * Pure function — no DI. Centralizes the fleet's canonical print settings (fit-page scale, centered,
 * best quality, threshold halftone, 2mm/1mm margins, `gapLength` 2.0) and the tape sizing derived
 * from the label's `W<width>H<height>` code. The caller merges the printer's `port` / `channelInfo`
 * onto the result before calling `BrotherPrint.printImage()`, so channel selection and loading UI stay
 * in the app.
 *
 * @param params - model, artwork, label, copies, and halftone threshold; see {@link KitBrotherPrintSettingsParams}
 * @returns the `BRLMPrintOptions` ready to be spread with `{ port, channelInfo }`
 * @example
 * ```ts
 * const settings = kitBuildBrotherPrintSettings({
 *   modelName, printBase64, label, numberOfCopies: printOptions.printNum, halftoneThreshold: printOptions.halftoneThreshold,
 * });
 * await BrotherPrint.printImage({ ...settings, port: channel.port, channelInfo: channel.channelInfo });
 * ```
 */
export const kitBuildBrotherPrintSettings = (params: KitBrotherPrintSettingsParams): BRLMPrintOptions => {
  const startPoint = params.printBase64.indexOf(',');
  const tapeSize = params.label.match(/W(\d+)H(\d+)/);
  const tapeWidth = tapeSize && tapeSize.length >= 2 ? parseInt(tapeSize[1], 10) : 0;
  const tapeLength = tapeSize && tapeSize.length >= 3 ? parseInt(tapeSize[2], 10) : 0;

  // `BRLMPrintOptions` is a `QL | TD` union; a die-cut label legitimately carries fields from both
  // groups, so the object is composed via spreads to bypass the union's excess-property checks — the
  // same technique the source printer services used.
  return {
    ...{
      modelName: params.modelName,
      encodedImage: params.printBase64.slice(startPoint + 1),
      numberOfCopies: params.numberOfCopies,
      autoCut: true,

      scaleMode: BRLMPrinterScaleMode.FitPageAspect,
      imageRotation: BRLMPrinterImageRotation.Rotate0,
      verticalAlignment: BRLMPrinterVerticalAlignment.Center,
      horizontalAlignment: BRLMPrinterHorizontalAlignment.Center,
      printQuality: BRLMPrinterPrintQuality.Best,
    },
    ...{
      labelName: params.label,
    },
    ...{
      paperType: BRLMPrinterCustomPaperType.dieCutPaper,
      paperUnit: BRLMPrinterCustomPaperUnit.mm,
      halftone: BRLMPrinterHalftone.Threshold,
      halftoneThreshold: params.halftoneThreshold,
      tapeWidth: Number(tapeWidth.toFixed(1)),
      tapeLength: Number(tapeLength.toFixed(1)),
      gapLength: 2.0,

      marginTop: 1.0,
      marginRight: 2.0,
      marginBottom: 1.0,
      marginLeft: 2.0,

      paperMarkPosition: 0,
      paperMarkLength: 0,
    },
  };
};
