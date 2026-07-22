import { InjectionToken } from '@angular/core';

export interface OfflinePersistenceErrorContext {
  operation: 'storeFresh';
  method: string;
  url: string;
}

/** Reports background persistence failures without replacing a successful HTTP response. */
export interface OfflineErrorReporter {
  report(error: unknown, context: OfflinePersistenceErrorContext): void;
}

export const OFFLINE_ERROR_REPORTER = new InjectionToken<OfflineErrorReporter>('OFFLINE_ERROR_REPORTER', {
  providedIn: 'root',
  factory: () => ({
    report: (error, context) => console.error('[offline] persistence failed', context, error),
  }),
});
