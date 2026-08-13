import type { OfflineAggregateIntentProjectInput, OfflineAggregateIntentProjection } from './offline-aggregate-intent-projector';
import type { OfflineCommandIdentity, OfflineReplicaIdentity } from './offline-identity';
import type { OfflineGeneratedRemoteId, OfflineNaturalKey } from './offline-replica-schema';
import type { OfflineReplicaRow, OfflineReplicaRowKey } from './offline-repository';

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

function rowKey(row: OfflineReplicaRowKey): string {
  const identity =
    row.identity.kind === 'local' || row.identity.kind === 'generated' ? row.identity.localId : JSON.stringify(row.identity.naturalKey);
  return `${row.userId}:${row.scopeId}:${row.sourceKey}:${identity}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function foldPayload(values: Record<string, unknown>, payload: unknown): Record<string, unknown> {
  const patch = asRecord(payload);
  const { method: _method, kind, attachment: _attachment, removeAttachmentId: _remove, ...rest } = patch;
  if (kind === 'delta' && typeof rest['qty'] === 'number') {
    const qty = typeof values['qty'] === 'number' ? values['qty'] : 0;
    return { ...values, ...rest, qty: qty + (rest['qty'] as number) };
  }
  if (kind === 'stocktake' && typeof rest['qty'] === 'number') {
    return { ...values, ...rest };
  }
  return { ...values, ...rest };
}

/**
 * Deterministic test projector: folds remaining payloads onto confirmed values
 * and covers every declared localOnly footprint exactly once.
 */
export function rematerializeTestAggregate(input: OfflineAggregateIntentProjectInput): OfflineAggregateIntentProjection {
  const footprint = new Map<string, OfflineReplicaRow | OfflineReplicaRowKey>();
  for (const row of input.localOnlyRows) footprint.set(rowKey(row), row);
  for (const command of input.commands) {
    for (const key of command.localOnlyFootprint ?? []) {
      if (!footprint.has(rowKey(key))) footprint.set(rowKey(key), key);
    }
  }
  const currentByKey = new Map(input.localOnlyRows.map((row) => [rowKey(row), row] as const));
  const putLocalOnlyRows: OfflineReplicaRow[] = [];
  const removeLocalOnlyRows: OfflineReplicaRowKey[] = [];

  if (input.commands.length === 0) {
    for (const ref of footprint.values()) {
      const current = 'values' in ref ? ref : currentByKey.get(rowKey(ref));
      if (current && 'confirmedValues' in current && current.confirmedValues != null) {
        putLocalOnlyRows.push({
          ...current,
          values: current.confirmedValues,
          syncState: 'confirmed',
          visibility: 'present',
        });
      } else {
        removeLocalOnlyRows.push(current ?? ref);
      }
    }
    if (!input.baseRow || input.baseRow.confirmedValues == null) {
      return { baseRow: null, putLocalOnlyRows, removeLocalOnlyRows };
    }
    return {
      baseRow: {
        ...input.baseRow,
        values: input.baseRow.confirmedValues,
        syncState: 'confirmed',
        visibility: 'present',
      },
      putLocalOnlyRows,
      removeLocalOnlyRows,
    };
  }

  const first = input.commands[0]!;
  const last = input.commands.at(-1)!;
  let values = asRecord(input.baseRow?.confirmedValues);
  const generatedRemoteId =
    input.baseRow?.identity.kind === 'generated' ? input.baseRow.identity.remoteId : first.identity.kind === 'generated' ? null : undefined;
  if ((input.baseRow == null || input.baseRow.confirmedValues == null) && first.identity.kind === 'generated') {
    values = { id: generatedRemoteId ?? 0, ...values };
  }
  if ((input.baseRow == null || input.baseRow.confirmedValues == null) && first.identity.kind === 'natural') {
    values = { ...first.identity.naturalKey, ...values };
  }
  const attachments = new Map<string, string>();
  for (const row of input.localOnlyRows) {
    if (row.identity.kind === 'local' && typeof (row.values as { name?: string }).name === 'string') {
      attachments.set(row.identity.localId, (row.values as { name: string }).name);
    }
  }
  for (const command of input.commands) {
    values = foldPayload(values, command.payload);
    const payload = asRecord(command.payload);
    const attachment = payload['attachment'];
    if (attachment && typeof attachment === 'object' && !Array.isArray(attachment)) {
      const item = attachment as { id?: unknown; name?: unknown };
      if (typeof item.id === 'string' && typeof item.name === 'string') attachments.set(item.id, item.name);
    }
    if (typeof payload['removeAttachmentId'] === 'string') attachments.delete(payload['removeAttachmentId']);
  }
  if (generatedRemoteId != null) values = { ...values, id: generatedRemoteId };

  const baseRow: OfflineReplicaRow = input.baseRow
    ? {
        ...input.baseRow,
        values: { ...asRecord(input.baseRow.values), ...values },
        syncState: 'pending',
        visibility: last.replicaMutation === 'delete' ? 'pending_delete' : 'present',
      }
    : {
        userId: first.userId,
        scopeId: first.scopeId,
        sourceKey: first.sourceKey,
        identity:
          first.identity.kind === 'generated'
            ? { kind: 'generated', localId: first.identity.localId, remoteId: null }
            : { kind: 'natural', naturalKey: first.identity.naturalKey },
        values,
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending',
        visibility: last.replicaMutation === 'delete' ? 'pending_delete' : 'present',
      };

  for (const ref of footprint.values()) {
    const current = 'values' in ref ? ref : currentByKey.get(rowKey(ref));
    if (ref.sourceKey.endsWith('_views') || ref.sourceKey.endsWith('_view')) {
      const title = typeof values['title'] === 'string' ? values['title'] : undefined;
      const qty = typeof values['qty'] === 'number' ? values['qty'] : undefined;
      const viewValues = {
        ...(current && 'values' in current ? asRecord(current.values) : {}),
        ...(title !== undefined ? { title } : {}),
        ...(qty !== undefined ? { qty } : {}),
      };
      const source = current && 'values' in current ? current : null;
      if (!source && Object.keys(viewValues).length === 0) {
        removeLocalOnlyRows.push(ref);
        continue;
      }
      putLocalOnlyRows.push({
        ...(source ?? {
          ...ref,
          values: viewValues,
          confirmedValues: null,
          serverRevision: null,
          fetchedAt: 1,
          syncState: 'pending' as const,
        }),
        values: viewValues,
        confirmedValues: source?.confirmedValues ?? null,
        syncState: 'pending',
        visibility: 'present',
      });
      continue;
    }
    if (ref.identity.kind === 'local') {
      const name = attachments.get(ref.identity.localId);
      if (name === undefined) {
        removeLocalOnlyRows.push(current ?? ref);
        continue;
      }
      const source = current && 'values' in current ? current : null;
      putLocalOnlyRows.push({
        ...(source ?? {
          ...ref,
          values: { name },
          confirmedValues: null,
          serverRevision: null,
          fetchedAt: 1,
          syncState: 'pending' as const,
        }),
        values: { name },
        confirmedValues: source?.confirmedValues ?? null,
        syncState: 'pending',
        visibility: 'present',
      });
      continue;
    }
    if (current && 'confirmedValues' in current && current.confirmedValues != null) {
      putLocalOnlyRows.push({ ...current, values: current.confirmedValues, syncState: 'pending', visibility: 'present' });
    } else {
      removeLocalOnlyRows.push(current ?? ref);
    }
  }

  return { baseRow, putLocalOnlyRows, removeLocalOnlyRows };
}
