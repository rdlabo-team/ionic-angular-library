/** A user-facing message (alert header + body). */
export interface KitAuthMessage {
  readonly header: string;
  readonly message: string;
}

/**
 * The fleet's canonical Firebase auth error dictionary: error `code` → message, plus a fallback for
 * unmapped codes.
 *
 * @remarks
 * The kit does *not* present errors itself (that's an app side effect). This is offered as an
 * importable constant so an app can render its error alert from a shared, canonical source instead of
 * re-declaring the same five messages. Apps that need `$localize` (i18n) keep their own dictionary;
 * JA-only apps can import {@link KIT_DEFAULT_AUTH_TEXT} and spread it, overriding the odd code.
 *
 * @example
 * ```ts
 * import { KIT_DEFAULT_AUTH_TEXT } from '@rdlabo/ionic-angular-kit/auth-firebase';
 *
 * const AUTH_ERRORS = { ...KIT_DEFAULT_AUTH_TEXT.errors, 'auth/wrong-password': { header: '…', message: '…' } };
 * presentError(code: string) {
 *   const msg = AUTH_ERRORS[code] ?? KIT_DEFAULT_AUTH_TEXT.fallbackError;
 *   return this.overlay.alertClose(msg);
 * }
 * ```
 */
export interface KitAuthText {
  /** Firebase error `code` → message. */
  readonly errors: Readonly<Record<string, KitAuthMessage>>;
  /** Shown when an error has no matching `code`. */
  readonly fallbackError: KitAuthMessage;
}

/** The fleet's canonical Japanese error dictionary (see {@link KitAuthText}). */
export const KIT_DEFAULT_AUTH_TEXT: KitAuthText = {
  errors: {
    'auth/invalid-email': { header: 'メールアドレスが間違っています', message: 'メールアドレスのフォーマットが間違っています。ご確認ください。' },
    'auth/user-not-found': {
      header: 'ユーザが見つかりません',
      message: '入力いただいたユーザは存在しません。登録されていないメールアドレスか、すでに退会しています。',
    },
    'auth/wrong-password': {
      header: 'パスワードが間違っています',
      message: '入力いただいたパスワードが間違っているか、このユーザはFacebookログインを利用しており、パスワードログインを有効にしていません。',
    },
    'auth/weak-password': {
      header: '脆弱性があります',
      message: 'パスワードは最低でも6文字以上のものをご利用ください。大文字小文字数字が混在しているとセキュリティを高めることにつながります。',
    },
    'auth/email-already-in-use': {
      header: 'ユーザが存在しています',
      message: 'このメールアドレスを利用してすでにユーザが作成されています。ログイン画面に戻って、ログインください。',
    },
  },
  fallbackError: { header: 'エラー', message: '処理に失敗しました' },
};
