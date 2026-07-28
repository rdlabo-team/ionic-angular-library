import { describe, expect, it } from 'vitest';
import {
  OfflineMutationProtocolError,
  parseOfflineMutationEnvelope,
  type OfflineMutationEnvelopeOptions,
} from './offline-mutation-envelope';

const options = (
  id: OfflineMutationEnvelopeOptions['id'],
  values: OfflineMutationEnvelopeOptions['values'],
): OfflineMutationEnvelopeOptions => ({ id, values, label: 'Tweet mutation', url: '/offline/tweets' });

describe('parseOfflineMutationEnvelope', () => {
  it('parses a required canonical id and object values', () => {
    expect(
      parseOfflineMutationEnvelope<{ title: string }>({ id: 7, revision: 2, values: { title: 'saved' } }, options('required', 'object')),
    ).toEqual({
      id: 7,
      revision: 2,
      values: { title: 'saved' },
    });
  });

  it('returns null for an absent optional id and rejects an invalid present id', () => {
    expect(parseOfflineMutationEnvelope({ revision: 2, values: {} }, options('optional', 'object')).id).toBeNull();
    expect(() => parseOfflineMutationEnvelope({ id: undefined, revision: 2, values: {} }, options('optional', 'object'))).toThrow(
      OfflineMutationProtocolError,
    );
    expect(() => parseOfflineMutationEnvelope({ id: 0, revision: 2, values: {} }, options('optional', 'object'))).toThrow(
      OfflineMutationProtocolError,
    );
    expect(() => parseOfflineMutationEnvelope({ id: Number.NaN, revision: 2, values: {} }, options('optional', 'object'))).toThrow(
      OfflineMutationProtocolError,
    );
  });

  it('rejects aliases instead of accepting them as a required canonical id', () => {
    expect(() => parseOfflineMutationEnvelope({ serverId: 7, revision: 2, values: {} }, options('required', 'object'))).toThrow(
      OfflineMutationProtocolError,
    );
    expect(() => parseOfflineMutationEnvelope({ remoteId: 7, revision: 2, values: {} }, options('required', 'object'))).toThrow(
      OfflineMutationProtocolError,
    );
  });

  it.each(['id', 'serverId', 'remoteId'] as const)('rejects own %s under the forbidden id policy', (key) => {
    expect(() => parseOfflineMutationEnvelope({ [key]: undefined, revision: 2, values: null }, options('forbidden', 'tombstone'))).toThrow(
      OfflineMutationProtocolError,
    );
  });

  it('accepts only null under the tombstone policy', () => {
    expect(parseOfflineMutationEnvelope({ revision: 2, values: null }, options('forbidden', 'tombstone'))).toEqual({
      id: null,
      revision: 2,
      values: null,
    });
    expect(() => parseOfflineMutationEnvelope({ revision: 2, values: {} }, options('forbidden', 'tombstone'))).toThrow(
      OfflineMutationProtocolError,
    );
    expect(() => parseOfflineMutationEnvelope({ revision: 2 }, options('forbidden', 'tombstone'))).toThrow(OfflineMutationProtocolError);
  });

  it('accepts objects and tombstones under the object-or-tombstone policy', () => {
    expect(parseOfflineMutationEnvelope({ revision: 2, values: {} }, options('forbidden', 'object-or-tombstone')).values).toEqual({});
    expect(parseOfflineMutationEnvelope({ revision: 2, values: null }, options('forbidden', 'object-or-tombstone')).values).toBeNull();
  });

  it('allows absent or explicit undefined values only under the optional policy', () => {
    expect(parseOfflineMutationEnvelope({ revision: 2 }, options('forbidden', 'optional-object-or-tombstone')).values).toBeUndefined();
    expect(
      parseOfflineMutationEnvelope({ revision: 2, values: undefined }, options('forbidden', 'optional-object-or-tombstone')).values,
    ).toBeUndefined();
    expect(() => parseOfflineMutationEnvelope({ revision: 2 }, options('forbidden', 'object-or-tombstone'))).toThrow(
      OfflineMutationProtocolError,
    );
  });

  it.each(['object', 'object-or-tombstone', 'optional-object-or-tombstone'] as const)(
    'rejects arrays under the %s values policy',
    (policy) => {
      expect(() => parseOfflineMutationEnvelope({ revision: 2, values: [] }, options('forbidden', policy))).toThrow(
        OfflineMutationProtocolError,
      );
    },
  );

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5])('rejects invalid revision %s', (revision) => {
    expect(() => parseOfflineMutationEnvelope({ revision, values: null }, options('forbidden', 'tombstone'))).toThrow(
      OfflineMutationProtocolError,
    );
  });

  it('throws a retryable 502 HttpErrorResponse with label and url context', () => {
    try {
      parseOfflineMutationEnvelope([], options('required', 'object'));
      expect.unreachable('Expected parsing to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(OfflineMutationProtocolError);
      expect(error).toMatchObject({
        status: 502,
        statusText: 'Bad Gateway',
        url: '/offline/tweets',
        error: {
          code: 'OFFLINE_MUTATION_PROTOCOL_ERROR',
          message: 'Tweet mutation must be an object.',
        },
      });
    }
  });
});
