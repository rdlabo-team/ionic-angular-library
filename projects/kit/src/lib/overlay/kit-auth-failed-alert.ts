import type { AlertController } from '@ionic/angular/standalone';

/**
 * Content for {@link kitPresentAuthFailedAlert}.
 */
export interface KitAuthFailedAlertOptions {
  /** Alert header, e.g. "ログインできませんでした". */
  header: string;
  /** Optional sub-header; typically the short server error code/name. */
  subHeader?: string;
  /** Alert body message; typically the server-provided detail. */
  message: string;
  /** Text for the single close button, e.g. "閉じる". */
  closeText: string;
}

/**
 * Present the fleet's canonical "sign-in / token exchange failed" alert.
 *
 * @remarks
 * Folds together the alert every token-exchange app duplicated verbatim when a startup re-login
 * fails: an informative alert (header + optional server error as sub-header + detail message) with a
 * single close button that reloads the app (`location.reload()`) so the user restarts cleanly. The
 * caller is still responsible for signing the user out around this call.
 *
 * All user-facing text is supplied by the caller so the kit stays free of any hardcoded i18n. Kept
 * as a standalone helper (taking the `AlertController`) rather than a method on
 * {@link KitOverlayController}, which holds no navigation policy such as `location.reload()`.
 *
 * @param alertCtrl - Ionic's `AlertController`
 * @param options - alert content plus the close-button text
 * @returns a Promise that resolves once the alert has been presented
 * @example
 * ```ts
 * onAuthorized: async () => {
 *   const logged = await auth.tokenLogin().catch(async (e) => {
 *     await kitPresentAuthFailedAlert(alertCtrl, {
 *       header: 'ログインできませんでした',
 *       subHeader: e.error.error,
 *       message: e.error.detail,
 *       closeText: '閉じる',
 *     });
 *     await auth.signOut();
 *     return undefined;
 *   });
 *   // ...
 * };
 * ```
 */
export const kitPresentAuthFailedAlert = async (
  alertCtrl: AlertController,
  options: KitAuthFailedAlertOptions,
): Promise<void> => {
  const alert = await alertCtrl.create({
    header: options.header,
    subHeader: options.subHeader,
    message: options.message,
    buttons: [
      {
        text: options.closeText,
        role: 'cancel',
        handler: () => {
          location.reload();
        },
      },
    ],
  });
  await alert.present();
};
