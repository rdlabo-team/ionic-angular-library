import { Routes } from '@angular/router';
import { TabsPage } from './tabs.page';

export const routes: Routes = [
  {
    path: 'tabs',
    component: TabsPage,
    children: [
      {
        path: 'tab1',
        loadComponent: () => import('../photo-editor/demo-photo-editor-page.component').then((m) => m.DemoPhotoEditorPage),
      },
      {
        path: 'tab2',
        loadComponent: () => import('../scroll-header/scroll-header.page').then((m) => m.ScrollHeaderPage),
      },
      {
        path: 'tab3',
        loadComponent: () => import('../virtual-scroll-header/virtual-scroll-header.page').then((m) => m.VirtualScrollHeaderPage),
      },
      {
        path: '',
        redirectTo: '/tabs/tab1',
        pathMatch: 'full',
      },
    ],
  },
  {
    path: '',
    redirectTo: '/tabs/tab1',
    pathMatch: 'full',
  },
];
