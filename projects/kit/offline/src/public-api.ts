/** Standard scoped local replica and outbox runtime for offline-capable Ionic applications. */
export * from './lib/offline-replica-schema';
export * from './lib/offline-identity';
export * from './lib/offline-aggregate-intent-projector';
export * from './lib/offline-replica-puller';
export * from './lib/offline-replica-pull.service';
export * from './lib/offline-replica-mutation-coordinator';
export * from './lib/offline-command-executor';
export * from './lib/offline-command-hooks';
export * from './lib/offline-auth-bridge';
export * from './lib/offline-coordinator.service';
export * from './lib/offline-kit-options';
export * from './lib/offline-local-reset';
export * from './lib/offline-mutation-envelope';
export { OfflineMutationPersistenceDisabledError } from './lib/offline-mutation-admission.service';
export {
  OfflineMutationPersistencePendingError,
  OfflineMutationPersistenceRequiresOnlineError,
  OfflineMutationPersistenceService,
} from './lib/offline-mutation-persistence.service';
export * from './lib/offline-network.service';
export * from './lib/offline-provider';
export * from './lib/offline-repository';
export * from './lib/offline-request-policy';
export * from './lib/offline-session.service';
export * from './lib/offline-storage';
export * from './lib/offline-sync.service';
export * from './lib/offline.interceptor';
export * from './lib/sqlite-offline-repository';
