import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { IonNav, IonRouterOutlet, ModalController, NavController, NavParams, PopoverController } from '@ionic/angular/standalone';

import { IonRouterOutletMock } from '../mocks/angular/ion-router-outlet';
import { ModalControllerMock } from '../mocks/angular/modal-controller';
import { NavControllerMock } from '../mocks/angular/nav-controller';
import { PopoverControllerMock } from '../mocks/angular/popover-controller';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';

import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app/app.routes';
import { AngularDelegate } from '@ionic/angular';

import { MockAngularDelegate } from '../mocks/angular/angular-delegate';

/**
 * Standalone configuration for Angular tests
 *
 * This is the recommended approach for new tests and for migrating existing tests.
 * It aligns with Angular's direction towards standalone components.
 */
export const testConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withComponentInputBinding()),
    importProvidersFrom(ReactiveFormsModule),
    NavParams,
    IonNav,
    {
      provide: AngularDelegate,
      useClass: MockAngularDelegate,
    },
    {
      provide: IonRouterOutlet,
      useFactory: () => IonRouterOutletMock.instance(),
    },
    {
      provide: ModalController,
      useFactory: () => ModalControllerMock.instance(),
    },
    {
      provide: NavController,
      useFactory: () => NavControllerMock.instance(),
    },
    {
      provide: PopoverController,
      useFactory: () => PopoverControllerMock.instance(),
    },
    provideHttpClient(withInterceptorsFromDi()),
    provideHttpClientTesting(),
  ],
};
