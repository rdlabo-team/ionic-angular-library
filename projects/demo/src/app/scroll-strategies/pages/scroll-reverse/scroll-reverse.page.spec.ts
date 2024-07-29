import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollReversePage } from './scroll-reverse.page';

describe('ScrollReversePage', () => {
  let component: ScrollReversePage;
  let fixture: ComponentFixture<ScrollReversePage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ScrollReversePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
