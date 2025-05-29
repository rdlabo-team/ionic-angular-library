export interface ScrollAdvancedItem {
  trackId: string;
  name: string;
  description: string;
  photo: string;
}

export interface DynamicSizeCache {
  trackId: number | string;
  itemSize: number;
}
