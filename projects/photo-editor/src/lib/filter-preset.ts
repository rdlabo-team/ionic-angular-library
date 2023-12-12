export const filterPreset = (): {
  name: string;
  type: string;
  option: any;
}[] => [
  {
    name: 'オリジナル',
    type: 'Default',
    option: null,
  },
  // {
  //   name: '反転',
  //   type: 'Invert',
  //   option: null,
  // },
  {
    name: 'セピア',
    type: 'Sepia',
    option: null,
  },
  {
    name: 'ヴィンテージ',
    type: 'vintage',
    option: null,
  },
  {
    name: 'ぼかし',
    type: 'Blur',
    option: { blur: 0.1 },
  },
  {
    name: 'グレースケール',
    type: 'Grayscale',
    option: null,
  },
  // {
  //   name: '輪郭',
  //   type: 'Sharpen',
  //   option: null,
  // },
  // {
  //   name: 'エンボス',
  //   type: 'Emboss',
  //   option: null,
  // },
];
