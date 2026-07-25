/** Standard scoped local replica and outbox runtime for offline-capable Ionic applications. */
export {
  OfflineCapabilityError,
  type OfflineCapability,
  type OfflineCapabilityKind,
  withOfflineOutbox,
  withOfflineReadFallback,
  withOfflineReplicaPull,
} from './lib/offline-capabilities';
export * from './lib/offline-replica-schema';
export * from './lib/offline-replica-puller';
export * from './lib/offline-replica-pull.service';
export * from './lib/offline-replica-query.service';
export * from './lib/offline-command-executor';
export * from './lib/offline-command-hooks';
export * from './lib/offline-coordinator.service';
export * from './lib/offline-kit-options';
export * from './lib/offline-network.service';
export {
  provideOffline,
  type ProvideOfflineBaseOptions,
  type ProvideOfflineCapabilityOptions,
  type ProvideOfflineConfiguration,
  type ProvideOfflineLegacyOptions,
  type ProvideOfflineOptions,
} from './lib/offline-provider';
export * from './lib/offline-repository';
export * from './lib/offline-request-policy';
export * from './lib/offline-session.service';
export * from './lib/offline-sync.service';
export * from './lib/offline.interceptor';
export * from './lib/sqlite-offline-repository';
