import { TestBed } from '@angular/core/testing';

import { DynamicSizeVirtualScrollService } from './dynamic-size-virtual-scroll.service';

describe('DynamicSizeVirtualScrollService', () => {
  let service: DynamicSizeVirtualScrollService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DynamicSizeVirtualScrollService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
