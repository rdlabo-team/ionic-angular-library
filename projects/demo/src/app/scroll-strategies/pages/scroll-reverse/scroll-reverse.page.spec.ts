import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScrollReversePage } from './scroll-reverse.page';
import { testConfig } from '../../../../test.config';

describe('ScrollReversePage', () => {
  let component: ScrollReversePage;
  let fixture: ComponentFixture<ScrollReversePage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testConfig.providers,
    }).compileComponents();
    fixture = TestBed.createComponent(ScrollReversePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
