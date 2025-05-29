import { TestBed } from '@angular/core/testing';

import { ScrollAdvancedCalcService } from './scroll-advanced-calc.service';
import { testConfig } from '../../test.config';

describe('ScrollAdvancedCalcService', () => {
  let service: ScrollAdvancedCalcService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testConfig.providers,
    }).compileComponents();
    service = TestBed.inject(ScrollAdvancedCalcService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
