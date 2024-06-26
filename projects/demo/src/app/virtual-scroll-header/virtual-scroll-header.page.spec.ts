import { ComponentFixture, TestBed } from '@angular/core/testing';
import { VirtualScrollHeaderPage } from './virtual-scroll-header.page';

describe('VirtualScrollHeaderPage', () => {
  let component: VirtualScrollHeaderPage;
  let fixture: ComponentFixture<VirtualScrollHeaderPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(VirtualScrollHeaderPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
