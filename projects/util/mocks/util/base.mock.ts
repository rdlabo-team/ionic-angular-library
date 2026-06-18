import { vi } from 'vitest';

export abstract class BaseMock {
  protected spyObj: any;

  // eslint-disable-next-line
  constructor(baseName: string, methodNames: any[]) {
    this.spyObj = methodNames.reduce((obj: any, methodName: string) => {
      obj[methodName] = vi.fn();
      return obj;
    }, {});

    methodNames.forEach((methodName) => {
      // @ts-ignore
      this[methodName] = this.spyObj[methodName];
    });
  }
}
