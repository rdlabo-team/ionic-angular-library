import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollSimplePage } from './scroll-simple.page';
import { testConfig } from '../../../../test.config';

describe('ScrollSimplePage', () => {
  let component: ScrollSimplePage;
  let fixture: ComponentFixture<ScrollSimplePage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testConfig.providers,
    }).compileComponents();
    fixture = TestBed.createComponent(ScrollSimplePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
