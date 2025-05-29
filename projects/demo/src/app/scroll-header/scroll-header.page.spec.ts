import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollHeaderPage } from './scroll-header.page';
import { testConfig } from '../../test.config';

describe('ScrollHeaderPage', () => {
  let component: ScrollHeaderPage;
  let fixture: ComponentFixture<ScrollHeaderPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testConfig.providers,
    }).compileComponents();
    fixture = TestBed.createComponent(ScrollHeaderPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
