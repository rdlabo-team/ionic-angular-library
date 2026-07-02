/*
 * Public API Surface of @rdlabo/ionic-angular-kit
 */

// Storage: typed wrapper around the platform key/value store.
export * from './lib/storage/kit-storage.service';

// Overlay: wrapper around the Ionic Modal / Toast / Alert controllers.
export * from './lib/overlay/overlay-config';
export * from './lib/overlay/kit-overlay.controller';
export * from './lib/overlay/kit-loading.controller';
export * from './lib/overlay/kit-reload-alert.controller';
export * from './lib/overlay/kit-auth-failed-alert';
export * from './lib/overlay/kit-language-action-sheet';

// Directives.
export * from './lib/directives/autofill.directive';

// Keyboard: native keyboard reposition listeners.
export * from './lib/keyboard/kit-keyboard';

// Theme: light/dark controller with OS-follow and native status-bar sync.
export * from './lib/theme/theme-config';
export * from './lib/theme/kit-theme.controller';

// Review: throttled native in-app review request.
export * from './lib/review/kit-request-review';

// Printer: pure Brother label plumbing (DOM→PNG, rotation, print-settings assembly).
export * from './lib/printer/kit-printer';

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
