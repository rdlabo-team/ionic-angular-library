import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScrollAdvancedItemComponent } from './scroll-advanced-item.component';
import { testConfig } from '../../../../test.config';
import { ComponentRef } from '@angular/core';

describe('ScrollAdvancedItemComponent', () => {
  let component: ScrollAdvancedItemComponent;
  let fixture: ComponentFixture<ScrollAdvancedItemComponent>;
  let componentRef: ComponentRef<ScrollAdvancedItemComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testConfig.providers,
    }).compileComponents();
    fixture = TestBed.createComponent(ScrollAdvancedItemComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('item', {
      trackId: 'track-01',
      name: null,
      description: null,
      photo: null,
    });

    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
