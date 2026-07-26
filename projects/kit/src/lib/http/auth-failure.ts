/**
 * Shared lifecycle boundary carried by an HTTP 401 response.
 *
 * Only `identity` invalidates the application's global authenticated identity.
 * The other scopes retain it and let the owning feature handle recovery.
 */
export const AUTH_FAILURE_SCOPES = {
  identity: 'identity',
  reauthentication: 'reauthentication',
  credential: 'credential',
} as const;

export type AuthFailureScope = (typeof AUTH_FAILURE_SCOPES)[keyof typeof AUTH_FAILURE_SCOPES];

export const AUTH_IDENTITY_INVALID_CODE = 'AUTH_IDENTITY_INVALID';

export interface AuthFailureBody {
  statusCode: 401;
  message: string;
  code: string;
  authFailureScope: AuthFailureScope;
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null;

const isAuthFailureScope = (value: unknown): value is AuthFailureScope =>
  Object.values(AUTH_FAILURE_SCOPES).some((scope) => scope === value);

/**
 * Reads the explicit auth-failure scope from an Angular `HttpErrorResponse` or
 * from a body-like value. Untagged legacy 401 responses intentionally return
 * `null`; applications can then choose their own compatibility fallback.
 */
export const getAuthFailureScope = (error: unknown): AuthFailureScope | null => {
  if (!isRecord(error)) return null;

  const body = isRecord(error['error']) ? error['error'] : error;
  const status = typeof error['status'] === 'number' ? error['status'] : body['statusCode'];
  if (status !== 401) return null;

  return isAuthFailureScope(body['authFailureScope']) ? body['authFailureScope'] : null;
};

/** True only for an explicitly tagged global identity failure. */
export const isIdentityAuthFailure = (error: unknown): boolean => getAuthFailureScope(error) === AUTH_FAILURE_SCOPES.identity;
