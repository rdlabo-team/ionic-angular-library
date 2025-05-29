import { ComponentFixture, TestBed } from '@angular/core/testing';
import { VirtualScrollHeaderPage } from './virtual-scroll-header.page';
import { testConfig } from '../../test.config';

describe('VirtualScrollHeaderPage', () => {
  let component: VirtualScrollHeaderPage;
  let fixture: ComponentFixture<VirtualScrollHeaderPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testConfig.providers,
    }).compileComponents();
    fixture = TestBed.createComponent(VirtualScrollHeaderPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
