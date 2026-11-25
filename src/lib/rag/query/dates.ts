export interface RelativeDateRange {
  from: string;
  to: string;
  includeUndated: true;
  timeZone: string;
}

export interface NormalizedDates {
  range: RelativeDateRange | null;
  denseSuffix: string | null;
  matched: string[];
  timeZone: string;
}

export function resolveTimeZone(_timeZone?: string | null): string {
  return 'UTC';
}

export function normalizeRelativeDates(_q: string, _opts: { now: Date; timeZone?: string | null }): NormalizedDates {
  return { range: null, denseSuffix: null, matched: [], timeZone: 'UTC' };
}
