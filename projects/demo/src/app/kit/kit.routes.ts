import { Routes } from '@angular/router';
import { KitPage } from './pages/kit/kit.page';

export const routes: Routes = [
  {
    path: '',
    component: KitPage,
  },
  {
    path: 'auth',
    loadChildren: () => import('./auth/auth.routes').then((m) => m.routes),
  },
];
