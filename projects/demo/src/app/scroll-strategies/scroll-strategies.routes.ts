import { Routes } from '@angular/router';
import { DemoPhotoEditorPage } from '../photo-editor/demo-photo-editor-page.component';
import { ScrollHeaderPage } from '../scroll-header/scroll-header.page';
import { VirtualScrollHeaderPage } from '../virtual-scroll-header/virtual-scroll-header.page';
import { ScrollStrategiesPage } from './pages/scroll-strategies/scroll-strategies.page';
import { ScrollSimplePage } from './pages/scroll-simple/scroll-simple.page';

export const routes: Routes = [
  {
    path: '',
    component: ScrollStrategiesPage,
  },
  {
    path: 'simple',
    component: ScrollSimplePage,
  },
];
