import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { getAuthFailureScope, isIdentityAuthFailure } from './auth-failure';

describe('auth failure protocol', () => {
  it.each(['identity', 'reauthentication', 'credential'] as const)('reads %s from an HTTP 401', (scope) => {
    const code = scope === 'identity' ? 'AUTH_IDENTITY_INVALID' : 'DOMAIN_CODE';
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        statusCode: 401,
        message: 'Unauthorized',
        code,
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

  it('rejects a mismatched body status or an identity scope without the standard identity code', () => {
    expect(
      getAuthFailureScope({
        status: 401,
        error: { statusCode: 403, code: 'AUTH_IDENTITY_INVALID', authFailureScope: 'identity' },
      }),
    ).toBeNull();
    expect(
      getAuthFailureScope({
        status: 403,
        error: { statusCode: 403, code: 'BUSINESS_FORBIDDEN', authFailureScope: 'identity' },
      }),
    ).toBeNull();
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

  it('accepts an explicitly tagged historical 403 identity failure', () => {
    expect(
      isIdentityAuthFailure(
        new HttpErrorResponse({
          status: 403,
          error: {
            statusCode: 403,
            message: 'Forbidden resource',
            code: 'AUTH_IDENTITY_INVALID',
            authFailureScope: 'identity',
          },
        }),
      ),
    ).toBe(true);
  });
});
