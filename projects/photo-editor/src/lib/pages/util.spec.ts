import { vi } from 'vitest';

import { waitToFindDom } from './util';

describe('waitToFindDom', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves after the requested descendant is added', async () => {
    const host = document.createElement('div');
    const clearInterval = vi.spyOn(globalThis, 'clearInterval');
    let resolved = false;
    const result = waitToFindDom(host, '.ready').then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    const child = document.createElement('span');
    child.className = 'ready';
    host.append(child);
    await result;

    expect(resolved).toBe(true);
    expect(clearInterval).toHaveBeenCalledOnce();
  });
});
