export abstract class BaseMock {
  protected spyObj: any;

  constructor(baseName: string, methodNames: any[]) {
    this.spyObj = jasmine.createSpyObj(baseName, methodNames);

    methodNames.forEach((methodName) => {
      // @ts-expect-error This is use for abstract
      this[methodName] = this.spyObj[methodName];
    });
  }
}
