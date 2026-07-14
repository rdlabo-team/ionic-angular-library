import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { DemoAuthService } from '../../auth.service';
import { environment } from '../../../../../environments/environment';

@Component({
  selector: 'app-kit-auth',
  templateUrl: './auth.page.html',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonNote,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthPage {
  readonly #auth = inject(DemoAuthService);
  readonly authState = toSignal(this.#auth.isAuth(), { initialValue: 'required' as const });
  readonly firebaseConfigured = !!environment.firebase.apiKey;
}
