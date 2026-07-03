// Social login (Facebook / Apple). Its own entry point so only apps that use it pull in the native
// plugins `@capacitor-community/facebook-login` and `@capacitor-community/apple-sign-in`; the core
// `auth-firebase` entry stays free of them.
//
// Public surface is curated: two bundled flows plus their option types. The nonce util, the error
// classifier and the 3-mode credential state machine are internal implementation details.
export * from './kit-social';
