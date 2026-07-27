import type { OfflineCommandIdentity, OfflineReplicaIdentity } from './offline-identity';
import type { OfflineGeneratedRemoteId, OfflineNaturalKey } from './offline-replica-schema';

/** Generated replica/command identity for tests. */
export function generatedReplicaIdentity(localId: string, remoteId: OfflineGeneratedRemoteId | null = null): OfflineReplicaIdentity {
  return { kind: 'generated', localId, remoteId };
}

/** Natural replica/command identity for tests. */
export function naturalReplicaIdentity(naturalKey: OfflineNaturalKey): OfflineReplicaIdentity {
  return { kind: 'natural', naturalKey };
}

/** Generated outbox identity for tests. */
export function generatedCommandIdentity(localId: string): OfflineCommandIdentity {
  return { kind: 'generated', localId };
}

/** Natural outbox identity for tests. */
export function naturalCommandIdentity(naturalKey: OfflineNaturalKey): OfflineCommandIdentity {
  return { kind: 'natural', naturalKey };
}
