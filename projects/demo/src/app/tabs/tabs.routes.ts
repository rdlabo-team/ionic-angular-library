import { Routes } from '@angular/router';
import { TabsPage } from './tabs.page';
import { DemoPhotoEditorPage } from '../photo-editor/demo-photo-editor-page.component';
import { ScrollHeaderPage } from '../scroll-header/scroll-header.page';
import { VirtualScrollHeaderPage } from '../virtual-scroll-header/virtual-scroll-header.page';
import { ScrollStrategiesPage } from '../scroll-strategies/scroll-strategies.page';

export const routes: Routes = [
  {
    path: 'tabs',
    component: TabsPage,
    children: [
      {
        path: 'tab1',
        component: DemoPhotoEditorPage,
      },
      {
        path: 'tab2',
        component: ScrollHeaderPage,
      },
      {
        path: 'tab3',
        component: VirtualScrollHeaderPage,
      },
      {
        path: 'tab4',
        component: ScrollStrategiesPage,
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
