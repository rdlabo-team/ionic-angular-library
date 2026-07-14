import { Routes } from '@angular/router';
import {
  kitRequireAuthorizedGuard,
  kitRequireConfirmingGuard,
  kitRequiredUnauthorizedGuard,
} from '@rdlabo/ionic-angular-kit';
import { AuthPage } from './pages/auth/auth.page';
import { ConfirmPage } from './pages/confirm/confirm.page';
import { HomePage } from './pages/home/home.page';
import { ResetPasswordPage } from './pages/reset-password/reset-password.page';
import { SigninPage } from './pages/signin/signin.page';
import { SignupPage } from './pages/signup/signup.page';

export const routes: Routes = [
  {
    path: '',
    component: AuthPage,
  },
  {
    path: 'signin',
    component: SigninPage,
    canActivate: [kitRequiredUnauthorizedGuard],
  },
  {
    path: 'signup',
    component: SignupPage,
    canActivate: [kitRequiredUnauthorizedGuard],
  },
  {
    path: 'confirm',
    component: ConfirmPage,
    canActivate: [kitRequireConfirmingGuard],
  },
  {
    path: 'home',
    component: HomePage,
    canActivate: [kitRequireAuthorizedGuard],
  },
  {
    path: 'reset',
    component: ResetPasswordPage,
    canActivate: [kitRequiredUnauthorizedGuard],
  },
];
