import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollStrategiesPage } from './scroll-strategies.page';
import { testConfig } from '../../../../test.config';

describe('ScrollStrategiesPage', () => {
  let component: ScrollStrategiesPage;
  let fixture: ComponentFixture<ScrollStrategiesPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testConfig.providers,
    }).compileComponents();
    fixture = TestBed.createComponent(ScrollStrategiesPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
