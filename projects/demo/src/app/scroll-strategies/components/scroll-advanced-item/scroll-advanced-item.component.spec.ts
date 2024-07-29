import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { IonicModule } from '@ionic/angular';

import { ScrollAdvancedItemComponent } from './scroll-advanced-item.component';

describe('ScrollAdvancedItemComponent', () => {
  let component: ScrollAdvancedItemComponent;
  let fixture: ComponentFixture<ScrollAdvancedItemComponent>;

  beforeEach(waitForAsync(() => {
    TestBed.configureTestingModule({
      declarations: [ScrollAdvancedItemComponent],
      imports: [IonicModule.forRoot()],
    }).compileComponents();

    fixture = TestBed.createComponent(ScrollAdvancedItemComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }));

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
