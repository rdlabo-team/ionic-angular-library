import { TestBed } from '@angular/core/testing';

import { DynamicSizeVirtualScrollService } from './dynamic-size-virtual-scroll.service';
import { testConfig } from '../../../util/test.config';

describe('DynamicSizeVirtualScrollService', () => {
  let service: DynamicSizeVirtualScrollService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    service = TestBed.inject(DynamicSizeVirtualScrollService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
