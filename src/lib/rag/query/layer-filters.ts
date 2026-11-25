import type { RetrievalFilters } from '../backend/types';

export interface LayerDateRange {
  from: string;
  to: string;
  includeUndated: boolean;
}

export function mergeLayerDateRange(filters: RetrievalFilters, _range: LayerDateRange | null): RetrievalFilters {
  return filters;
}
