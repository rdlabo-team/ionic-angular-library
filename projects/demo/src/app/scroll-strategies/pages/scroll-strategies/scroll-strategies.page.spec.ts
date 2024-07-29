import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollStrategiesPage } from './scroll-strategies.page';

describe('ScrollStrategiesPage', () => {
  let component: ScrollStrategiesPage;
  let fixture: ComponentFixture<ScrollStrategiesPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ScrollStrategiesPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
