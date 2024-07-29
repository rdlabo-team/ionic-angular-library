import { TestBed } from '@angular/core/testing';

import { ScrollAdvancedCalcService } from './scroll-advanced-calc.service';

describe('ScrollAdvancedCalcService', () => {
  let service: ScrollAdvancedCalcService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ScrollAdvancedCalcService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
