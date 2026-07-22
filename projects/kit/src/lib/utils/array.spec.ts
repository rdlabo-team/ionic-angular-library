/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { arrayConcatById } from './array';

interface Row {
  id: number;
  label: string;
}

describe('arrayConcatById', () => {
  it('returns [] when both inputs are empty', () => {
    expect(arrayConcatById<Row>([], [], 'id')).toEqual([]);
  });

  it('merges new rows over old by key and sorts DESC by default', () => {
    const old: Row[] = [
      { id: 3, label: 'old-3' },
      { id: 2, label: 'old-2' },
      { id: 1, label: 'old-1' },
    ];
    const fresh: Row[] = [
      { id: 3, label: 'new-3' },
      { id: 2, label: 'new-2' },
    ];
    const result = arrayConcatById<Row>(old, fresh, 'id');
    expect(result.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(result.find((r) => r.id === 3)?.label).toBe('new-3');
    expect(result.find((r) => r.id === 1)?.label).toBe('old-1');
  });

  it('sorts ASC when requested', () => {
    const result = arrayConcatById<Row>([{ id: 1, label: 'a' }], [{ id: 2, label: 'b' }], 'id', 'ASC');
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });

  it('drops old items sharing a secondaryKey with a new item', () => {
    type Node = { id: number; parentId: number };
    const old: Node[] = [
      { id: 5, parentId: 1 },
      { id: 4, parentId: 2 },
    ];
    const fresh: Node[] = [{ id: 6, parentId: 1 }];
    // Single-item window keeps all old; without secondaryKey both survive.
    expect(arrayConcatById<Node>(old, fresh, 'id').map((n) => n.id)).toEqual([6, 5, 4]);
    // With secondaryKey 'parentId': old id 5 shares parentId 1 with new id 6 → dropped; id 4 kept.
    expect(arrayConcatById<Node>(old, fresh, 'id', 'DESC', 'parentId').map((n) => n.id)).toEqual([6, 4]);
  });
});
