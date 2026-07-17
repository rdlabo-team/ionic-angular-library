import type { InputSignal, InputSignalWithTransform, OutputEmitterRef, Signal } from '@angular/core';

/**
 * Component のうち Signal（computed / input / viewChild 等）と `output()` だけを
 * ViewModel から見えるようにする型。`vm` は循環参照になるため除外する。
 *
 * 注意: `new ViewModel(this)` の引数型に直接使うと、vm 依存 computed の推論と循環する。
 * ViewModel 側は constructor(host: Component) で受け、フィールドを `ReactiveHost<Component>` に
 * 絞り込むこと（呼び出し点では ReactiveHost を展開しない）。
 */
export type ReactiveHost<T> = Pick<
  T,
  {
    [K in Exclude<keyof T, 'vm'>]-?: T[K] extends Signal<unknown>
      ? K
      : T[K] extends OutputEmitterRef<any>
        ? K
        : never;
  }[Exclude<keyof T, 'vm'>]
>;

/**
 * Modal / page に渡す props オブジェクトを、Angular `input()` の InputSignal 形に写す型。
 * `implements ComponentPropsType<Props>` で component 側の input 宣言を揃える。
 */
export type ComponentPropsType<T> = {
  [K in keyof T]: InputSignal<T[K]> | InputSignalWithTransform<T[K], any>;
};
