/**
 * Disable the button that triggered an event while an async operation runs, re-enabling it after.
 *
 * @remarks
 * Prevents the common double-submit / double-tap bug: the `event.target` button is disabled, the
 * work is awaited, and the button is re-enabled — even if the work rejects (the rejection is
 * swallowed here so the button always recovers; handle errors inside `work` if you need to react).
 *
 * @param event - The DOM event whose `target` is the button to disable (e.g. a click event).
 * @param work - The async operation to run while the button is disabled.
 * @returns A Promise that resolves once the work has settled and the button has been re-enabled.
 * @example
 * ```ts
 * async submit(event: Event): Promise<void> {
 *   await disableHandler(event, this.save());
 * }
 * ```
 */
export const disableHandler = async (event: Event, work: Promise<void | boolean>): Promise<void> => {
  const target = event.target as HTMLButtonElement;
  target.disabled = true;
  await work.catch((): undefined => undefined);
  target.disabled = false;
};
