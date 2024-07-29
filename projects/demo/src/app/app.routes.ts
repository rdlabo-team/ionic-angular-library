import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadChildren: () => import('./tabs/tabs.routes').then((m) => m.routes),
  },
  {
    path: 'scroll-simple',
    loadComponent: () => import('./scroll-strategies/pages/scroll-simple/scroll-simple.page').then((m) => m.ScrollSimplePage),
  },
];
