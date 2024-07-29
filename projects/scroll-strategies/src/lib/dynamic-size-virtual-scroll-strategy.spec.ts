import { calcIndex, itemDynamicSize } from './dynamic-size-virtual-scroll-strategy';

describe('DynamicSizeVirtualScrollStrategy', () => {
  const dynamicSizes: itemDynamicSize[] = [...Array(100)].map((_, i) => ({
    itemSize: i,
    trackId: i,
  }));

  it('calcIndex', () => {
    expect(calcIndex(dynamicSizes, 10, 5)).toEqual(0.833333333333333);
    expect(calcIndex(dynamicSizes, 100)).toEqual(13.642857142857142);
  });

  it('calcIndexMin', () => {
    const dynamic = [
      {
        itemSize: 55,
      },
      {
        itemSize: 55,
      },
      {
        itemSize: 42,
      },
    ];
    expect(calcIndex(dynamic, 50)).toEqual(0);
    expect(calcIndex(dynamic, 60)).toEqual(0.09090909090909091);
  });

  it('calcReverseIndex', () => {
    expect(calcIndex(dynamicSizes, 10, 2, true)).toEqual(1);
    expect(calcIndex(dynamicSizes, 200, 30, true)).toEqual(6.818181818181813);
  });

  it('RangeChangeStartHasTrouble', () => {
    const dynamic = [
      {
        itemSize: 55,
        trackId: 5803450,
        source: 'cache',
      },
      {
        itemSize: 55,
        trackId: 5803467,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5803578,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5803580,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5803582,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5803584,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5806334,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5806335,
        source: 'cache',
      },
      {
        itemSize: 50,
        trackId: 5810037,
        source: 'cache',
      },
      {
        itemSize: 50,
        trackId: 5810038,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5810441,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5810801,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 5811405,
        source: 'cache',
      },
      {
        itemSize: 248,
        trackId: 8548047,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8548161,
        source: 'cache',
      },
      {
        itemSize: 256,
        trackId: 8549402,
        source: 'cache',
      },
      {
        itemSize: 400,
        trackId: 8549909,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8552783,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8552784,
        source: 'cache',
      },
      {
        itemSize: 42,
        trackId: 8552795,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8602039,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8602043,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8602049,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8602061,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8602081,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8602098,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8602289,
        source: 'cache',
      },
      {
        itemSize: 50,
        trackId: 8604018,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8604027,
        source: 'cache',
      },
      {
        itemSize: 55,
        trackId: 8604034,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8606476,
        source: 'cache',
      },
      {
        itemSize: 55,
        trackId: 8606490,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 8606497,
        source: 'cache',
      },
      {
        itemSize: 256,
        trackId: 8606501,
        source: 'cache',
      },
      {
        itemSize: 55,
        trackId: 8606504,
        source: 'cache',
      },
      {
        itemSize: 59,
        trackId: 8606514,
        source: 'cache',
      },
      {
        itemSize: 55,
        trackId: 8606518,
        source: 'cache',
      },
      {
        itemSize: 59,
        trackId: 8607015,
        source: 'cache',
      },
      {
        itemSize: 50,
        trackId: 8607062,
        source: 'cache',
      },
      {
        itemSize: 248,
        trackId: 9987383,
        source: 'cache',
      },
      {
        itemSize: 59,
        trackId: 9987384,
        source: 'cache',
      },
      {
        itemSize: 59,
        trackId: 9987385,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987386,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987387,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987388,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987389,
        source: 'cache',
      },
      {
        itemSize: 90,
        trackId: 9987390,
        source: 'cache',
      },
      {
        itemSize: 96,
        trackId: 9987395,
        source: 'cache',
      },
      {
        itemSize: 96,
        trackId: 9987396,
        source: 'cache',
      },
      {
        itemSize: 96,
        trackId: 9987397,
        source: 'cache',
      },
      {
        itemSize: 280,
        trackId: 9987419,
        source: 'cache',
      },
      {
        itemSize: 66,
        trackId: 9987420,
        source: 'cache',
      },
      {
        itemSize: 208,
        trackId: 9987421,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987422,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987423,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987424,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987425,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987426,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987427,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987428,
        source: 'cache',
      },
      {
        itemSize: 116,
        trackId: 9987429,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987430,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987431,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987432,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987433,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987434,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987435,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987436,
        source: 'cache',
      },
      {
        itemSize: 47,
        trackId: 9987437,
        source: 'cache',
      },
    ];
    expect(calcIndex(dynamic, 1610, 50.95357142856153)).toEqual(17.04642857143847);
  });
});
