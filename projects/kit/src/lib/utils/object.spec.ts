import { objectEqual } from './object';

describe('objectEqual', () => {
  it('returns true for the same reference', () => {
    const a = { x: 1 };
    expect(objectEqual(a, a)).toBe(true);
  });

  it('is insensitive to key order', () => {
    expect(objectEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('compares nested objects regardless of key order', () => {
    expect(objectEqual({ a: { p: 1, q: 2 } }, { a: { q: 2, p: 1 } })).toBe(true);
  });

  it('returns false when a value differs', () => {
    expect(objectEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns false when a nested value differs', () => {
    expect(objectEqual({ a: { p: 1 } }, { a: { p: 2 } })).toBe(false);
  });
});
