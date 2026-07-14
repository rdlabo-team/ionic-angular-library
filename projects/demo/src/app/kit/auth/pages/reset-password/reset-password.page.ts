import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form, FormField, required } from '@angular/forms/signals';
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
} from '@ionic/angular/standalone';
import { KitAuthInputDirective } from '@rdlabo/ionic-angular-kit';
import { DemoAuthService } from '../../auth.service';

@Component({
  selector: 'app-kit-reset-password',
  templateUrl: './reset-password.page.html',
  imports: [
    FormField,
    KitAuthInputDirective,
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
export class ResetPasswordPage {
  readonly credentials = signal({ email: '' });
  readonly resetForm = form(this.credentials, (s) => {
    required(s.email);
  });
  readonly isLoading = signal(false);
  readonly #auth = inject(DemoAuthService);

  async doReset(): Promise<void> {
    this.isLoading.set(true);
    await this.#auth.sendPasswordReset(this.credentials().email).finally(() => this.isLoading.set(false));
  }
}
