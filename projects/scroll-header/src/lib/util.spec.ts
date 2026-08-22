import { waitFindDom } from './util';

describe('waitFindDom', () => {
  it('resolves once the requested descendant is added', async () => {
    const host = document.createElement('div');
    let resolved = false;
    const result = waitFindDom(host, '.target').then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);

    const target = document.createElement('span');
    target.className = 'target';
    host.append(target);
    await result;

    expect(resolved).toBe(true);
  });
});
