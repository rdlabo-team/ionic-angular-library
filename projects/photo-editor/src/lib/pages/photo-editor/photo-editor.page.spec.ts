import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { PhotoEditorPage } from './photo-editor.page';
import { testConfig } from '../../../../../util/test.config';

describe('PhotoEditorPage', () => {
  let component: PhotoEditorPage;
  let fixture: ComponentFixture<PhotoEditorPage>;
  let componentRef: ComponentRef<PhotoEditorPage>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: testConfig.providers,
    });
    fixture = TestBed.createComponent(PhotoEditorPage);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('value', 'data:image/png;base64,');
    componentRef.setInput('headerButtonColorScheme', 'dark');
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('applies the configured dark color scheme to the header', () => {
    const header = fixture.nativeElement.querySelector('ion-header');
    const closeButton = header.querySelector('ion-button');

    expect(header.classList.contains('photo-editor-header-buttons-dark')).toBe(true);
    expect(header.classList.contains('photo-editor-header-buttons-light')).toBe(false);
    expect(header.style.colorScheme).toBe('dark');
    expect(getComputedStyle(closeButton).getPropertyValue('--color').trim()).toBe(
      'var(--ion-photo-editor-header-button-color-on-dark, #f4f5f8)',
    );
  });

  it('applies the configured light color scheme to regular Ionic buttons', () => {
    componentRef.setInput('headerButtonColorScheme', 'light');
    fixture.detectChanges();
    const header = fixture.nativeElement.querySelector('ion-header');
    const closeButton = header.querySelector('ion-button');

    expect(header.classList.contains('photo-editor-header-buttons-dark')).toBe(false);
    expect(header.classList.contains('photo-editor-header-buttons-light')).toBe(true);
    expect(header.style.colorScheme).toBe('light');
    expect(getComputedStyle(closeButton).getPropertyValue('--color').trim()).toBe(
      'var(--ion-photo-editor-header-button-color-on-light, #222428)',
    );
  });
});
