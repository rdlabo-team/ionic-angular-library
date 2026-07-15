/*
 * Public API Surface of @rdlabo/ionic-angular-kit
 */

// Storage: typed wrapper around the platform key/value store.
export * from './lib/storage/kit-storage.service';
// Remember/recall the last entered sign-in email (validated; storage-agnostic helpers).
export * from './lib/storage/kit-auth-email-store';
// Canonical keys (email + theme) for clear-preserving lists.
export * from './lib/storage/kit-storage-keys';
// Clear storage while restoring selected keys (e.g. last sign-in email on logout).
export * from './lib/storage/kit-clear-storage';

// Overlay: wrapper around the Ionic Modal / Toast / Alert controllers.
export * from './lib/overlay/overlay-config';
export * from './lib/overlay/kit-overlay.controller';
export * from './lib/overlay/kit-loading.controller';
export * from './lib/overlay/kit-reload-alert.controller';
export * from './lib/overlay/kit-maintenance.controller';
export * from './lib/overlay/kit-auth-failed-alert';
export * from './lib/overlay/kit-language-action-sheet';

// Directives.
export * from './lib/directives/auth-input.directive';

// Keyboard: native keyboard reposition listeners.
export * from './lib/keyboard/kit-keyboard';

// Theme (`@rdlabo/ionic-angular-kit/theme`), Review (`.../review`), Printer (`.../printer`) and
// Firebase auth (`.../auth-firebase`) are separate secondary entry points so their heavy native peers
// (status-bar / in-app-review+preferences / brotherprint+dom-to-image / firebase) are
// only pulled in by apps that import those subpaths.

// Auth: functional route guards.
export * from './lib/auth/auth-guards';

// HTTP: functional interceptor.
export * from './lib/http/kit-http.interceptor';

// Utils: framework-agnostic pure helpers.
export * from './lib/utils/haptics';
export * from './lib/utils/array';
export * from './lib/utils/object';
export * from './lib/utils/dom';
export * from './lib/utils/ionic-scroll-event';
export * from './lib/utils/ionic-view-enter';
