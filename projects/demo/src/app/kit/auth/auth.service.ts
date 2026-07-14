import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { type KitAuthState, KitOverlayController } from '@rdlabo/ionic-angular-kit';
import {
  KIT_DEFAULT_AUTH_TEXT,
  KIT_FIREBASE_AUTH,
  kitAuthState,
  kitResolveAuthStatus,
  kitSendEmailVerification,
  kitSendPasswordReset,
  kitSignIn,
  kitSignInAnonymously,
  kitSignOut,
  kitSignUp,
  type User,
} from '@rdlabo/ionic-angular-kit/auth-firebase';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class DemoAuthService {
  readonly #auth = inject(KIT_FIREBASE_AUTH);
  readonly #overlay = inject(KitOverlayController);

  /** Stream of the 4-state auth model consumed by `provideKitAuth`. */
  isAuth(isReload = false): Observable<KitAuthState> {
    return kitAuthState(this.#auth).pipe(
      mergeMap(async (user) => {
        if (isReload) {
          await this.#auth.currentUser?.reload();
        }
        if (user?.isAnonymous) {
          return 'anonymous' as const;
        }
        return kitResolveAuthStatus(user, {
          allowWhen: () => environment.e2e,
        });
      }),
    );
  }

  getState(): Observable<User | null> {
    return kitAuthState(this.#auth);
  }

  signIn(email: string, password: string): Promise<unknown> {
    return kitSignIn(this.#auth, email, password, {
      error: (e) => this.#presentError(e),
    });
  }

  signUp(email: string, password: string): Promise<unknown> {
    return kitSignUp(this.#auth, email, password, {
      success: () => void this.#overlay.presentToast({ message: 'Verification email sent' }),
      error: (e) => this.#presentError(e),
    });
  }

  signOut(): Promise<boolean> {
    return kitSignOut(this.#auth, {
      error: (e) => this.#presentError(e),
    });
  }

  signInAnonymously(): Promise<unknown> {
    return kitSignInAnonymously(this.#auth, {
      error: (e) => this.#presentError(e),
    });
  }

  sendPasswordReset(email: string): Promise<boolean> {
    return kitSendPasswordReset(this.#auth, email, {
      success: () => void this.#overlay.presentToast({ message: 'Password reset email sent' }),
      error: (e) => this.#presentError(e),
    });
  }

  sendEmailVerification(): Promise<boolean> {
    return kitSendEmailVerification(this.#auth, {
      success: () => void this.#overlay.presentToast({ message: 'Verification email sent' }),
      error: (e) => this.#presentError(e),
    });
  }

  #presentError(e: unknown): void {
    const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: string }).code) : '';
    const msg = KIT_DEFAULT_AUTH_TEXT.errors[code] ?? KIT_DEFAULT_AUTH_TEXT.fallbackError;
    void this.#overlay.alertClose(msg);
  }
}
