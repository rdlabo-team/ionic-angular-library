import { InjectionToken } from '@angular/core';
import type { OfflineCommand, OfflineScope } from './offline-repository';
import type { OfflineCommandIdentity, OfflinePrincipalId, OfflineReplicaIdentity } from './offline-identity';
import type { OfflineGeneratedRemoteId, OfflineNaturalKey } from './offline-replica-schema';

/** Server acknowledgement used to reconcile one optimistic local mutation. */
export interface OfflineCommandResult {
  /** Remote id returned by a successful generated-identity mutation. */
  remoteId?: OfflineGeneratedRemoteId;
  serverRevision?: string | number;
  /**
   * Full server-confirmed domain values after applying the mutation.
   *
   * Kit does not treat this as the durable confirmed baseline while the
   * command remains in the Outbox. Authoritative confirmed values come from
   * pull acknowledgement of `commandId`.
   */
  confirmedValues?: unknown;
  /** Removes the local replica row after a confirmed server delete. */
  removeReplica?: boolean;
  /**
   * Releases the deleted row's remote identity while keeping
   * its immutable local id for a queued recreate of the same logical target.
   */
  clearRemoteId?: boolean;
  response?: unknown;
}

/** Target identity resolved from the local replica immediately before transport. */
export type OfflineCommandTarget =
  | { readonly kind: 'generated'; readonly localId: string; readonly remoteId: OfflineGeneratedRemoteId | null }
  | { readonly kind: 'natural'; readonly naturalKey: OfflineNaturalKey };

/** Product adapter that sends commands and projects acknowledgements into entities. */
export interface OfflineCommandExecutor {
  /** Sends the command using `command.commandId` as its durable server-side idempotency key. */
  execute(command: OfflineCommand, target: OfflineCommandTarget): Promise<OfflineCommandResult>;
  withServerRevision(command: OfflineCommand, revision: string | number): OfflineCommand;
  /**
   * Whether this transport error authoritatively proves that this idempotency
   * key did not commit. Returning true may clear an ambiguity retained from an
   * earlier response-loss attempt and expose normal conflict resolution.
   */
  provesCommandNotCommitted?(error: unknown, command: OfflineCommand): boolean;
  /**
   * Removes the deleted remote row's revision from a queued recreate.
   * Required only when `clearRemoteId` completes while later commands remain.
   */
  withoutServerRevision?(command: OfflineCommand): OfflineCommand;
}

/** DI token for the product-specific command transport adapter. */
export const OFFLINE_COMMAND_EXECUTOR = new InjectionToken<OfflineCommandExecutor>('OFFLINE_COMMAND_EXECUTOR');

/** Authenticated user and partition scopes currently eligible for synchronization. */
export interface OfflineSyncSession {
  userId: OfflinePrincipalId;
  scopes: OfflineScope[];
}

/** Product adapter that exposes the currently authenticated synchronization session. */
export interface OfflineSyncContext {
  /** Session allowed to read/write the local replica and append durable outbox commands. */
  getLocalSession?(): Promise<OfflineSyncSession | null>;
  /** Remotely authenticated session allowed to pull and replay commands. */
  getSession(): Promise<OfflineSyncSession | null>;
}

/** DI token for authenticated synchronization context. */
export const OFFLINE_SYNC_CONTEXT = new InjectionToken<OfflineSyncContext>('OFFLINE_SYNC_CONTEXT');

/** Resolves the transport target from a replica row. */
export function offlineCommandTargetFromReplicaRow(row: { readonly identity: OfflineReplicaIdentity }): OfflineCommandTarget {
  if (row.identity.kind === 'natural') return { kind: 'natural', naturalKey: row.identity.naturalKey };
  if (row.identity.kind === 'local') throw new Error('Local-only replica rows cannot be synchronized.');
  return { kind: 'generated', localId: row.identity.localId, remoteId: row.identity.remoteId };
}

/** Resolves a command lookup identity from an enqueue request identity. */
export function offlineCommandLookupIdentity(identity: EnqueueOfflineCommandIdentity): OfflineCommandIdentity {
  if (identity.kind === 'generated') return { kind: 'generated', localId: identity.localId };
  return { kind: 'natural', naturalKey: identity.naturalKey };
}

/** Enqueue identity for generated entities. */
export interface EnqueueOfflineGeneratedIdentity {
  readonly kind: 'generated';
  readonly localId: string;
  readonly remoteId?: OfflineGeneratedRemoteId | null;
  readonly remoteIdHint?: OfflineGeneratedRemoteId | null;
}

/** Enqueue identity for natural-key entities. */
export interface EnqueueOfflineNaturalIdentity {
  readonly kind: 'natural';
  readonly naturalKey: OfflineNaturalKey;
}

export type EnqueueOfflineCommandIdentity = EnqueueOfflineGeneratedIdentity | EnqueueOfflineNaturalIdentity;
