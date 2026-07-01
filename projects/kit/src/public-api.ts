/*
 * Public API Surface of @rdlabo/ionic-angular-kit
 */

// Storage: typed wrapper around the platform key/value store.
export * from './lib/storage/kit-storage.service';

// Overlay: wrapper around the Ionic Modal / Toast / Alert controllers.
export * from './lib/overlay/overlay-config';
export * from './lib/overlay/kit-overlay.controller';
export * from './lib/overlay/kit-reload-alert.controller';
export * from './lib/overlay/kit-auth-failed-alert';

// Directives.
export * from './lib/directives/autofill.directive';

// Keyboard: native keyboard reposition listeners.
export * from './lib/keyboard/kit-keyboard.controller';

// Auth: functional route guards.
export * from './lib/auth/auth-guards';

// HTTP: functional interceptor.
export * from './lib/http/kit-http.interceptor';

// Utils: framework-agnostic pure helpers.
export * from './lib/utils/haptics';
export * from './lib/utils/array';
export * from './lib/utils/object';
export * from './lib/utils/dom';
