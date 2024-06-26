import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DemoPhotoEditorPage } from './demo-photo-editor-page.component';

describe('PhotoEditorPage', () => {
  let component: DemoPhotoEditorPage;
  let fixture: ComponentFixture<DemoPhotoEditorPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(DemoPhotoEditorPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
