export const waitFindDom = (nativeElement: HTMLElement, selector: string): Promise<void> => {
  return new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const find = nativeElement.querySelector(selector);
      if (find) {
        clearInterval(interval);
        resolve();
      }
    });
  });
};
