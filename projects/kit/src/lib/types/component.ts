import { afterNextRender } from '@angular/core';
import type { InputSignal, InputSignalWithTransform, OutputEmitterRef, Signal } from '@angular/core';

/**
 * Component のうち Signal（computed / input / viewChild 等）と `output()` だけを
 * ViewModel から見えるようにする型。`vm` は循環参照になるため除外する。
 *
 * 注意: `new ViewModel(this)` の引数型に直接使うと、vm 依存 computed の推論と循環する。
 * ViewModelStore 側は constructor(host: Component) で受け、`mountViewModel()` により
 * `ViewModelHost<Component, Keys>` へ絞り込むこと（呼び出し点では mapped type を展開しない）。
 */
export type ReactiveHost<T> = Pick<
  T,
  {
    [K in Exclude<keyof T, 'vm'>]-?: T[K] extends Signal<unknown> ? K : T[K] extends OutputEmitterRef<any> ? K : never;
  }[Exclude<keyof T, 'vm'>]
>;

/**
 * ViewModel に公開する Component の Signal と、明示的に許可した非 Signal property。
 */
export type ViewModelHost<T, K extends keyof T = never> = ReactiveHost<T> & Pick<T, K>;

/**
 * Component host を ViewModel 用に絞り込み、初回 render 後の mount hook を登録する。
 */
export function mountViewModel<T, K extends keyof T = never>(host: T, onMount?: () => void): ViewModelHost<T, K> {
  if (onMount) {
    afterNextRender(onMount);
  }
  return host as ViewModelHost<T, K>;
}

/**
 * Modal / page に渡す props オブジェクトを、Angular `input()` の InputSignal 形に写す型。
 * `implements ComponentPropsType<Props>` で component 側の input 宣言を揃える。
 */
export type ComponentPropsType<T> = {
  [K in keyof T]: InputSignal<T[K]> | InputSignalWithTransform<T[K], any>;
};
