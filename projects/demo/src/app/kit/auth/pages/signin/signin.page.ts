import type { OnDestroy } from '@angular/core';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form, FormField, required } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonSpinner,
  IonTitle,
  IonToolbar,
  NavController,
} from '@ionic/angular/standalone';
import { KitAuthInputDirective } from '@rdlabo/ionic-angular-kit';
import type { Subscription } from 'rxjs';
import { DemoAuthService } from '../../auth.service';

@Component({
  selector: 'app-kit-signin',
  templateUrl: './signin.page.html',
  imports: [
    FormField,
    KitAuthInputDirective,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonList,
    IonItem,
    IonInput,
    IonButton,
    IonSpinner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SigninPage implements OnDestroy {
  readonly credentials = signal({ email: '', password: '' });
  readonly loginForm = form(this.credentials, (s) => {
    required(s.email);
    required(s.password);
  });
  readonly isLoading = signal(false);

  readonly #auth = inject(DemoAuthService);
  readonly #navCtrl = inject(NavController);
  readonly #authSub: Subscription;

  constructor() {
    this.#authSub = this.#auth.isAuth().subscribe((state) => {
      if (state === 'user' || state === 'anonymous') {
        void this.#navCtrl.navigateRoot('/main/kit/auth/home');
      } else if (state === 'confirm') {
        void this.#navCtrl.navigateForward('/main/kit/auth/confirm');
      }
    });
  }

  ngOnDestroy(): void {
    this.#authSub.unsubscribe();
  }

  async doSignIn(): Promise<void> {
    this.isLoading.set(true);
    await this.#auth.signIn(this.credentials().email, this.credentials().password).finally(() => this.isLoading.set(false));
  }

  async doAnonymous(): Promise<void> {
    this.isLoading.set(true);
    await this.#auth.signInAnonymously().finally(() => this.isLoading.set(false));
  }
}
