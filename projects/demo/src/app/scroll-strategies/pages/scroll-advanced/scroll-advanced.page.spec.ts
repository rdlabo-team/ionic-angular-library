import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollAdvancedPage } from './scroll-advanced.page';

describe('ScrollAdvancedPage', () => {
  let component: ScrollAdvancedPage;
  let fixture: ComponentFixture<ScrollAdvancedPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ScrollAdvancedPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
