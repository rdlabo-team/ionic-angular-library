/**
 * Shared lifecycle boundary carried by an authentication failure response.
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
  statusCode: 401 | 403;
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
 * from a body-like value. Tagged historical 403 identity responses are
 * supported for installed-client compatibility. Untagged 401/403 responses
 * intentionally return `null`.
 */
export const getAuthFailureScope = (error: unknown): AuthFailureScope | null => {
  if (!isRecord(error)) return null;

  const body = isRecord(error['error']) ? error['error'] : error;
  const status = typeof error['status'] === 'number' ? error['status'] : body['statusCode'];
  if (status !== 401 && status !== 403) return null;
  if (body['statusCode'] !== status || typeof body['code'] !== 'string') return null;

  const scope = body['authFailureScope'];
  if (!isAuthFailureScope(scope)) return null;
  if (status === 403 && scope !== AUTH_FAILURE_SCOPES.identity) return null;
  if (scope === AUTH_FAILURE_SCOPES.identity && body['code'] !== AUTH_IDENTITY_INVALID_CODE) return null;
  return scope;
};

/** True only for an explicitly tagged global identity failure. */
export const isIdentityAuthFailure = (error: unknown): boolean => getAuthFailureScope(error) === AUTH_FAILURE_SCOPES.identity;
