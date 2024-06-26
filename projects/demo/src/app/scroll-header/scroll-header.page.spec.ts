import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollHeaderPage } from './scroll-header.page';

describe('ScrollHeaderPage', () => {
  let component: ScrollHeaderPage;
  let fixture: ComponentFixture<ScrollHeaderPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ScrollHeaderPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
