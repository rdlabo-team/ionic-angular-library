import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollSimplePage } from './scroll-simple.page';

describe('ScrollSimplePage', () => {
  let component: ScrollSimplePage;
  let fixture: ComponentFixture<ScrollSimplePage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ScrollSimplePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
