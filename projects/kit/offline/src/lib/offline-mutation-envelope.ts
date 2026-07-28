import { HttpErrorResponse } from '@angular/common/http';

/** Identity policy for a successful offline mutation response. */
export type OfflineMutationEnvelopeIdPolicy = 'required' | 'optional' | 'forbidden';

/** Values policy for a successful offline mutation response. */
export type OfflineMutationEnvelopeValuesPolicy = 'object' | 'tombstone' | 'object-or-tombstone' | 'optional-object-or-tombstone';

/** Runtime validation policy for a successful offline mutation response. */
export interface OfflineMutationEnvelopeOptions {
  readonly id: OfflineMutationEnvelopeIdPolicy;
  readonly values: OfflineMutationEnvelopeValuesPolicy;
  readonly label?: string;
  readonly url?: string;
}

/** Canonical successful mutation response consumed by offline command adapters. */
export interface OfflineMutationEnvelope<T extends Record<string, unknown>> {
  readonly id: number | null;
  readonly revision: number;
  readonly values: T | null | undefined;
}

/**
 * A successful HTTP response that violates the offline mutation protocol.
 *
 * Status 502 deliberately keeps the response in the retryable server-failure class.
 */
export class OfflineMutationProtocolError extends HttpErrorResponse {
  constructor(message: string, url?: string) {
    super({
      error: { code: 'OFFLINE_MUTATION_PROTOCOL_ERROR', message },
      status: 502,
      statusText: 'Bad Gateway',
      url,
    });
  }
}

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const isPositiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Strictly parses the wire envelope returned by an offline mutation endpoint. */
export function parseOfflineMutationEnvelope<T extends Record<string, unknown> = Record<string, unknown>>(
  input: unknown,
  options: OfflineMutationEnvelopeOptions,
): OfflineMutationEnvelope<T> {
  const label = options.label ?? 'Offline mutation response';
  const invalid = (detail: string): never => {
    throw new OfflineMutationProtocolError(`${label} ${detail}`, options.url);
  };

  const envelope = isRecord(input) ? input : invalid('must be an object.');

  let id: number | null = null;
  switch (options.id) {
    case 'required': {
      const rawId = envelope['id'];
      id = hasOwn(envelope, 'id') && isPositiveSafeInteger(rawId) ? rawId : invalid('id must be a positive safe integer.');
      break;
    }
    case 'optional': {
      if (hasOwn(envelope, 'id')) {
        const rawId = envelope['id'];
        id = isPositiveSafeInteger(rawId) ? rawId : invalid('id must be a positive safe integer when present.');
      }
      break;
    }
    case 'forbidden':
      if (['id', 'serverId', 'remoteId'].some((key) => hasOwn(envelope, key))) {
        invalid('must not contain id, serverId, or remoteId.');
      }
      break;
  }

  const rawRevision = envelope['revision'];
  const revision =
    hasOwn(envelope, 'revision') && isPositiveSafeInteger(rawRevision) ? rawRevision : invalid('revision must be a positive safe integer.');

  const values = envelope['values'];
  switch (options.values) {
    case 'object':
      if (!isRecord(values)) {
        invalid('values must be an object.');
      }
      break;
    case 'tombstone':
      if (values !== null) {
        invalid('values must be null.');
      }
      break;
    case 'object-or-tombstone':
      if (values !== null && !isRecord(values)) {
        invalid('values must be an object or null.');
      }
      break;
    case 'optional-object-or-tombstone':
      if (values !== undefined && values !== null && !isRecord(values)) {
        invalid('values must be an object, null, or undefined.');
      }
      break;
  }

  return { id, revision, values: values as T | null | undefined };
}
