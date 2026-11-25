import type { RetrievalFilters } from '../backend/types';

/** The query layer's relative-date range (D-11), ISO dates, inclusive. */
export interface LayerDateRange {
  from: string;
  to: string;
  includeUndated: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function validRange(range: LayerDateRange | null): range is LayerDateRange {
  return range !== null && ISO_DATE.test(range.from) && ISO_DATE.test(range.to) && range.from <= range.to;
}

function later(a: string | undefined, b: string): string {
  return a !== undefined && a > b ? a : b;
}

function earlier(a: string | undefined, b: string): string {
  return a !== undefined && a < b ? a : b;
}

/**
 * D-11: narrows the DATA-08 date filter with the layer's range and never widens it. Without an explicit range the layer
 * range applies with its includeUndated; with one the result is the intersection, and undated rows stay in only when both
 * sides allow them. Disjoint ranges give from > to, which matches nothing. Every other filter, and the tenant, is untouched.
 */
export function mergeLayerDateRange(filters: RetrievalFilters, range: LayerDateRange | null): RetrievalFilters {
  if (!validRange(range)) return filters;
  const explicit = filters.dateRange;
  if (!explicit || (explicit.from === undefined && explicit.to === undefined)) {
    return { ...filters, dateRange: { from: range.from, to: range.to, includeUndated: range.includeUndated } };
  }
  const from = later(explicit.from, range.from);
  const to = earlier(explicit.to, range.to);
  const includeUndated = from <= to && explicit.includeUndated === true && range.includeUndated;
  return { ...filters, dateRange: { from, to, includeUndated } };
}
