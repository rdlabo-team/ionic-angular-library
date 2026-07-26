import { inject, Injectable } from '@angular/core';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OFFLINE_REPOSITORY, type OfflineCommand, type OfflineReplicaRow, type OfflineScope } from './offline-repository';

/** High-level local replica reads that consistently apply optimistic visibility rules. */
@Injectable({ providedIn: 'root' })
export class OfflineReplicaQueryService {
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  readonly #hooks = inject(OFFLINE_COMMAND_HOOKS);

  /**
   * Returns the current optimistic rows visible to product projections.
   *
   * Pending delete commands act as local tombstones. Rejected or conflicted deletes remain visible so
   * products can present and resolve them instead of silently hiding server-confirmed data.
   */
  async getVisibleRows<TValues = unknown>(scope: OfflineScope, sourceKey: string): Promise<OfflineReplicaRow<TValues>[]> {
    const schema = this.#options.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    const [rows, commands] = await Promise.all([
      this.#repository.getReplicaRows<TValues>(scope, sourceKey),
      schema.scope === 'user' && this.#repository.getCommandsForUser
        ? this.#repository.getCommandsForUser(scope.userId)
        : this.#repository.getCommands(scope),
    ]);
    const hiddenLocalIds = new Set(
      commands.filter((command) => this.#isVisibleDelete(command, sourceKey)).map((command) => command.aggregateLocalId),
    );
    return rows.filter((row) => !hiddenLocalIds.has(row.localId));
  }

  #isVisibleDelete(command: OfflineCommand, sourceKey: string): boolean {
    return (
      command.effect === 'delete' &&
      command.state !== 'rejected' &&
      command.state !== 'conflict' &&
      this.#hooks.entityType(command) === sourceKey
    );
  }
}
