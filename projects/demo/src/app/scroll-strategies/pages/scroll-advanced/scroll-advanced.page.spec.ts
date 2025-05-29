import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollAdvancedPage } from './scroll-advanced.page';
import { testConfig } from '../../../../test.config';

describe('ScrollAdvancedPage', () => {
  let component: ScrollAdvancedPage;
  let fixture: ComponentFixture<ScrollAdvancedPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testConfig.providers,
    }).compileComponents();
    fixture = TestBed.createComponent(ScrollAdvancedPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
