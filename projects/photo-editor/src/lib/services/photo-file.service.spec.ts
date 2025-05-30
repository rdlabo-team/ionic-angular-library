import { TestBed } from '@angular/core/testing';

import { PhotoFileService } from './photo-file.service';
import { testConfig } from '../../../../util/test.config';

describe('PhotoService', () => {
  let service: PhotoFileService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [...testConfig.providers],
    });
    service = TestBed.inject(PhotoFileService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
