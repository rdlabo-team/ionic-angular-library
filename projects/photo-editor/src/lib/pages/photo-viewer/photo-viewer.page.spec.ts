import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { PhotoViewerPage } from './photo-viewer.page';
import { testConfig } from '../../../../../util/test.config';

describe('PhotoViewerPage', () => {
  let component: PhotoViewerPage;
  let fixture: ComponentFixture<PhotoViewerPage>;
  let componentRef: ComponentRef<PhotoViewerPage>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(PhotoViewerPage);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('imageUrls', []);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
