// Printer: Brother label plumbing (DOM→PNG, rotation, print-settings assembly).
// Split into its own entry point so only apps that print pull in `@rdlabo/capacitor-brotherprint`
// and `dom-to-image-more`; the core entry stays free of those native peers.
export * from './kit-printer';
