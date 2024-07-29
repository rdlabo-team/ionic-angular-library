import { Routes } from '@angular/router';
import { ScrollStrategiesPage } from './pages/scroll-strategies/scroll-strategies.page';
import { ScrollSimplePage } from './pages/scroll-simple/scroll-simple.page';
import { ScrollAdvancedPage } from './pages/scroll-advanced/scroll-advanced.page';
import { ScrollReversePage } from './pages/scroll-reverse/scroll-reverse.page';

export const routes: Routes = [
  {
    path: '',
    component: ScrollStrategiesPage,
  },
  {
    path: 'simple',
    component: ScrollSimplePage,
  },
  {
    path: 'advanced',
    component: ScrollAdvancedPage,
  },
  {
    path: 'reverse',
    component: ScrollReversePage,
  },
];
