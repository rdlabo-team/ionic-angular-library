import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { getAuthFailureScope, isIdentityAuthFailure } from './auth-failure';

describe('auth failure protocol', () => {
  it.each(['identity', 'reauthentication', 'credential'] as const)('reads %s from an HTTP 401', (scope) => {
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        statusCode: 401,
        message: 'Unauthorized',
        code: 'DOMAIN_CODE',
        authFailureScope: scope,
      },
    });

    expect(getAuthFailureScope(error)).toBe(scope);
    expect(isIdentityAuthFailure(error)).toBe(scope === 'identity');
  });

  it('does not infer a destructive identity failure from a legacy status alone', () => {
    expect(getAuthFailureScope(new HttpErrorResponse({ status: 401 }))).toBeNull();
    expect(isIdentityAuthFailure({ status: 403, error: { authFailureScope: 'identity' } })).toBe(false);
  });

  it('accepts a body-like value for non-Angular consumers', () => {
    expect(
      getAuthFailureScope({
        statusCode: 401,
        message: 'Unauthorized',
        code: 'AUTH_IDENTITY_INVALID',
        authFailureScope: 'identity',
      }),
    ).toBe('identity');
  });
});
