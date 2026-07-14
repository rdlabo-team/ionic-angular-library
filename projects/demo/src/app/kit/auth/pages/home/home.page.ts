import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
  NavController,
} from '@ionic/angular/standalone';
import { map } from 'rxjs/operators';
import { DemoAuthService } from '../../auth.service';

@Component({
  selector: 'app-kit-home',
  templateUrl: './home.page.html',
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomePage {
  readonly #auth = inject(DemoAuthService);
  readonly #navCtrl = inject(NavController);

  readonly authState = toSignal(this.#auth.isAuth(), { initialValue: 'required' as const });
  readonly email = toSignal(this.#auth.getState().pipe(map((u) => u?.email ?? (u?.isAnonymous ? '(anonymous)' : ''))), {
    initialValue: '',
  });

  async signOut(): Promise<void> {
    await this.#auth.signOut();
    void this.#navCtrl.navigateRoot('/main/kit/auth/signin');
  }
}
