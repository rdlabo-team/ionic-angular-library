import type { ElementRef } from '@angular/core';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Platform } from '@ionic/angular/standalone';

import { KitKeyboardController } from './kit-keyboard.controller';

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }) },
}));

function elementRef(): ElementRef {
  return { nativeElement: document.createElement('div') } as unknown as ElementRef;
}

describe('KitKeyboardController', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(isHybrid: boolean) {
    const platform = { is: vi.fn().mockImplementation((p: string) => (p === 'hybrid' ? isHybrid : false)) };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), KitKeyboardController, { provide: Platform, useValue: platform }],
    });
    return TestBed.inject(KitKeyboardController);
  }

  it('returns no handles on non-native (web) platforms', async () => {
    const controller = setup(false);
    expect(await controller.init(elementRef(), 'transform')).toEqual([]);
  });

  it('registers four keyboard listeners on native platforms', async () => {
    const controller = setup(true);
    const handles = await controller.init(elementRef(), 'offset');
    expect(handles).toHaveLength(4);
  });
});
