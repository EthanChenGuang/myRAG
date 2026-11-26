import type { ChunkExtractor, DateCandidate } from './index';

const MONTHS: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, sept: 9, october: 10, november: 11, december: 12,
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const CONFIDENCE_NUMERIC_YEAR_FIRST = 0.95;
const CONFIDENCE_MONTH_NAME = 0.9;
const CONFIDENCE_SLASH = 0.85;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_CANDIDATES_PER_CHUNK = 50;

function isoDate(year: number, month: number, day: number): string | null {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthNumber(name: string): number {
  return MONTHS[name.toLowerCase()] ?? 0;
}

interface DatePattern {
  regex: RegExp;
  confidence: number;
  read(match: RegExpExecArray): string | null;
}

const PATTERNS: readonly DatePattern[] = [
  {
    regex: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g,
    confidence: CONFIDENCE_NUMERIC_YEAR_FIRST,
    read: (m) => isoDate(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  {
    regex: /(\d{4})\s?年\s?(\d{1,2})\s?月\s?(\d{1,2})\s?日/g,
    confidence: CONFIDENCE_NUMERIC_YEAR_FIRST,
    read: (m) => isoDate(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  {
    regex: new RegExp(`(?<![\\p{L}\\d])(${MONTH_NAMES})\\s{1,3}(\\d{1,2})(?:st|nd|rd|th)?\\s?,?\\s{1,3}(\\d{4})(?!\\d)`, 'giu'),
    confidence: CONFIDENCE_MONTH_NAME,
    read: (m) => isoDate(Number(m[3]), monthNumber(m[1] ?? ''), Number(m[2])),
  },
  {
    regex: new RegExp(`(?<![\\d])(\\d{1,2})(?:st|nd|rd|th|°|º)?\\s{1,3}(?:of\\s{1,3})?(${MONTH_NAMES})(?![\\p{L}])\\s?,?\\s{1,3}(\\d{4})(?!\\d)`, 'giu'),
    confidence: CONFIDENCE_MONTH_NAME,
    read: (m) => isoDate(Number(m[3]), monthNumber(m[2] ?? ''), Number(m[1])),
  },
  {
    // Day-first and month-first both occur; a slash date is read only when one reading is impossible, never guessed.
    regex: /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/g,
    confidence: CONFIDENCE_SLASH,
    read: (m) => {
      const first = Number(m[1]);
      const second = Number(m[2]);
      const year = Number(m[3]);
      if (first > 12 && second <= 12) return isoDate(year, second, first);
      if (second > 12 && first <= 12) return isoDate(year, first, second);
      if (first === second) return isoDate(year, first, second);
      return null;
    },
  },
];

export interface DateSpan extends DateCandidate {
  /** Length of the matched date expression in the text. */
  length: number;
}

/** Full calendar dates in the text with their span, highest confidence first, then earliest position. */
export function findDateSpans(content: string): DateSpan[] {
  const found: DateSpan[] = [];
  for (const pattern of PATTERNS) {
    for (const match of content.matchAll(pattern.regex)) {
      const iso = pattern.read(match);
      if (iso) found.push({ iso, confidence: pattern.confidence, position: match.index ?? 0, length: match[0].length });
      if (found.length >= MAX_CANDIDATES_PER_CHUNK) break;
    }
  }
  return found.sort((a, b) => b.confidence - a.confidence || a.position - b.position).slice(0, MAX_CANDIDATES_PER_CHUNK);
}

/** Full calendar dates in the text, highest confidence first, then earliest position. Years-only, quarters and months are not full dates. */
export function findDateCandidates(content: string): DateCandidate[] {
  return findDateSpans(content).map(({ iso, confidence, position }) => ({ iso, confidence, position }));
}

export const extractDates: ChunkExtractor = ({ content, enhanced }) => ({
  metadata: {
    temporal_entities: enhanced.temporal_entities,
    temporal_density: enhanced.temporal_density,
    has_temporal_data: enhanced.temporal_entities.length > 0,
  },
  dateCandidates: findDateCandidates(content),
});

/** The document date: highest confidence, then earliest chunk, then earliest position in the chunk. */
export function pickDocDate(candidates: ReadonlyArray<DateCandidate & { chunkIndex: number }>): string | null {
  let best: (DateCandidate & { chunkIndex: number }) | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.confidence > best.confidence ||
      (candidate.confidence === best.confidence &&
        (candidate.chunkIndex < best.chunkIndex || (candidate.chunkIndex === best.chunkIndex && candidate.position < best.position)))
    ) {
      best = candidate;
    }
  }
  return best ? best.iso : null;
}
