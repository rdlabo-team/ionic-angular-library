import { TestBed, waitForAsync } from '@angular/core/testing';

import { PhotoFileService } from './photo-file.service';

describe('PhotoService', () => {
  let service: PhotoFileService;

  beforeEach(waitForAsync(() => {
    service = TestBed.inject(PhotoFileService);
  }));

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
