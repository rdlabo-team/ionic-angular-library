export const environment = {
  production: false,
  /**
   * Playwright が `window.__E2E__` を inject したときだけ true。
   * `allowWhen` でメール未確認でも `'user'` 扱いにし、confirm をスキップする。
   */
  e2e: typeof window !== 'undefined' && (window as { __E2E__?: boolean }).__E2E__ === true,
  firebase: {
    apiKey: 'AIzaSyBuGDgJy26KfViIjusAxVwHhyAbQTYKoAw',
    authDomain: 'ionic-angular-library.firebaseapp.com',
    projectId: 'ionic-angular-library',
    storageBucket: 'ionic-angular-library.firebasestorage.app',
    messagingSenderId: '626402728972',
    appId: '1:626402728972:web:0bd88eaeaf2402c9932229',
  },
};
