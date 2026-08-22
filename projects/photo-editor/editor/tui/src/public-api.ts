import { PhotoImageEditorFactory } from '@rdlabo/ionic-angular-photo-editor';

/** Creates a TUI Image Editor adapter in a bundler-resolvable lazy chunk. */
export const createTuiImageEditor: PhotoImageEditorFactory = async (host, options) => {
  const { default: ImageEditor } = await import('tui-image-editor');
  return new ImageEditor(host, options);
};
