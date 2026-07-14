import type { OnDestroy } from '@angular/core';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonNote,
  IonTitle,
  IonToolbar,
  NavController,
} from '@ionic/angular/standalone';
import type { Subscription } from 'rxjs';
import { map } from 'rxjs/operators';
import { firstValueFrom, timer } from 'rxjs';
import { DemoAuthService } from '../../auth.service';

@Component({
  selector: 'app-kit-confirm',
  templateUrl: './confirm.page.html',
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonNote, IonButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmPage implements OnDestroy {
  readonly #auth = inject(DemoAuthService);
  readonly #navCtrl = inject(NavController);
  readonly email = toSignal(this.#auth.getState().pipe(map((u) => u?.email ?? '')), { initialValue: '' });
  readonly #poll: Subscription;

  constructor() {
    this.#poll = timer(0, 2000).subscribe(async () => {
      const state = await firstValueFrom(this.#auth.isAuth(true));
      if (state === 'user') {
        void this.#navCtrl.navigateRoot('/main/kit/auth/home');
      }
    });
  }

  ngOnDestroy(): void {
    this.#poll.unsubscribe();
  }

  sendVerify(): void {
    void this.#auth.sendEmailVerification();
  }

  async signOut(): Promise<void> {
    await this.#auth.signOut();
    void this.#navCtrl.navigateRoot('/main/kit/auth/signin');
  }
}
