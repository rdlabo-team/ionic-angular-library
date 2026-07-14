import type { ApplicationConfig } from '@angular/core';
import { importProvidersFrom, inject, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { IonicStorageModule } from '@ionic/storage-angular';
import { provideKitAuth, provideKitOverlay } from '@rdlabo/ionic-angular-kit';
import { provideKitFirebase } from '@rdlabo/ionic-angular-kit/auth-firebase';

import { routes } from './app.routes';
import { DemoAuthService } from './kit/auth/auth.service';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideIonicAngular({ useSetInputAPI: true }),
    importProvidersFrom(IonicStorageModule.forRoot({ name: '__kit_demo_db' })),
    provideKitFirebase({ firebaseConfig: environment.firebase }),
    provideKitOverlay({ labels: { close: 'Close', cancel: 'Cancel' } }),
    provideKitAuth(() => {
      const auth = inject(DemoAuthService);
      return {
        authState: () => auth.isAuth(),
        redirects: {
          whenAuthorized: '/main/kit/auth/home',
          whenConfirming: '/main/kit/auth/confirm',
          whenNotConfirming: '/main/kit/auth/signin',
          whenUnauthorized: '/main/kit/auth/signin',
        },
      };
    }),
  ],
};
