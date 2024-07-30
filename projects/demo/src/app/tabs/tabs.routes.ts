import { Routes } from '@angular/router';
import { TabsPage } from './tabs.page';
import { DemoPhotoEditorPage } from '../photo-editor/demo-photo-editor-page.component';
import { ScrollHeaderPage } from '../scroll-header/scroll-header.page';
import { VirtualScrollHeaderPage } from '../virtual-scroll-header/virtual-scroll-header.page';

export const routes: Routes = [
  {
    path: 'main',
    component: TabsPage,
    children: [
      {
        path: 'photo-editor',
        component: DemoPhotoEditorPage,
      },
      {
        path: 'scroll-header',
        component: ScrollHeaderPage,
      },
      {
        path: 'virtual-scroll-header',
        component: VirtualScrollHeaderPage,
      },
      {
        path: 'scroll-strategies',
        loadChildren: () => import('../scroll-strategies/scroll-strategies.routes').then((m) => m.routes),
      },
      {
        path: '',
        redirectTo: '/main/photo-editor',
        pathMatch: 'full',
      },
    ],
  },
  {
    path: '',
    redirectTo: '/main/photo-editor',
    pathMatch: 'full',
  },
];
