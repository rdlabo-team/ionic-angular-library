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
});
