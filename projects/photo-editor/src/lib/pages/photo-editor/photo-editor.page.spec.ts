import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PhotoEditorPage } from './photo-editor.page';
import { testConfig } from '../../../../../util/test.config';

describe('PhotoEditorPage', () => {
  let component: PhotoEditorPage;
  let fixture: ComponentFixture<PhotoEditorPage>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(PhotoEditorPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
