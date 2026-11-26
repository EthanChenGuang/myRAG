import { findCitationMarkers } from '@/lib/citations/marker-grammar';
import type { AnswerSentence } from '@/lib/rag-eval/contracts.generated';
import { codeRanges } from './citation-markers';

export type SentenceMarkKind = 'uncited' | 'unsupported';

/** Reserved href of a sentence mark link: `#mark-<kind>-<part>-<index>` (UI-SPEC 6.2). */
export const MARK_HREF_PREFIX = '#mark-';

/** The offsets a sentence record or a blocked range carries: UTF-16 code units into text part `part` (D-23). */
export type SentenceOffsets = Pick<AnswerSentence, 'part' | 'start' | 'end' | 'text_hash'>;

export interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

export interface PlannedMark {
  id: string;
  kind: SentenceMarkKind;
  part: number;
  index: number;
  /** Insertion point in the part text. */
  at: number;
  table: boolean;
}

const MARK_HREF_RE = /^#mark-(uncited|unsupported)-(0|[1-9]\d{0,5})-(0|[1-9]\d{0,5})$/;
const HORIZONTAL_WS = /[ \t 　]/;
const TRAILING_WS = /\s/u;
/** Keeps a mark on the line of its sentence's last word. */
const WORD_JOINER = '⁠';
const NO_UNCITED_MARK: ReadonlySet<AnswerSentence['kind']> = new Set(['truncated', 'heading', 'code']);
const HASH_CACHE_LIMIT = 256;

const hashes = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function remember(text: string, hash: string): void {
  if (hashes.size >= HASH_CACHE_LIMIT) {
    const oldest = hashes.keys().next().value;
    if (oldest !== undefined) hashes.delete(oldest);
  }
  hashes.set(text, hash);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The SHA-256 hex of a part text, computed once per text with crypto.subtle and cached. */
export function partTextHash(text: string): Promise<string> {
  const known = hashes.get(text);
  if (known !== undefined) return Promise.resolve(known);
  const inFlight = pending.get(text);
  if (inFlight) return inFlight;
  const next = sha256Hex(text).then((hash) => {
    remember(text, hash);
    pending.delete(text);
    return hash;
  });
  pending.set(text, next);
  return next;
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function splitsPair(text: string, at: number): boolean {
  return at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && !isHigh(text.charCodeAt(at));
}

function offsetsFit<T extends SentenceOffsets>(parts: readonly string[], record: T): string | undefined {
  const { part, start, end } = record;
  if (!Number.isInteger(part) || part < 0 || part >= parts.length) return undefined;
  const text = parts[part];
  if (typeof text !== 'string') return undefined;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return undefined;
  if (splitsPair(text, start) || splitsPair(text, end)) return undefined;
  return text;
}

/**
 * D-23: the records whose part text hashes to their text_hash, or undefined while a needed hash is not computed yet.
 * Offsets outside the part, an unknown part or a split surrogate pair never verify.
 */
export function verifySentenceRecordsSync<T extends SentenceOffsets>(parts: readonly string[], records: readonly T[]): T[] | undefined {
  const kept: T[] = [];
  for (const record of records) {
    const text = offsetsFit(parts, record);
    if (text === undefined) continue;
    const hash = hashes.get(text);
    if (hash === undefined) return undefined;
    if (hash === record.text_hash) kept.push(record);
  }
  return kept;
}

/** D-23: verifies the records against the part texts with crypto.subtle; the hashes are cached per text. */
export async function verifySentenceRecords<T extends SentenceOffsets>(parts: readonly string[], records: readonly T[]): Promise<T[]> {
  const needed = new Set<string>();
  for (const record of records) {
    const text = offsetsFit(parts, record);
    if (text !== undefined) needed.add(text);
  }
  await Promise.all([...needed].map((text) => partTextHash(text)));
  return verifySentenceRecordsSync(parts, records) ?? [];
}

export function markKey(part: number, index: number): string {
  return `${part}:${index}`;
}

export function markId(kind: SentenceMarkKind, part: number, index: number): string {
  return `${kind}-${part}-${index}`;
}

export function markHref(kind: SentenceMarkKind, part: number, index: number): string {
  return `${MARK_HREF_PREFIX}${markId(kind, part, index)}`;
}

/** The mark a reserved href names, or null for any other href or a mark that is not shown. */
export function markFromHref(
  href: unknown,
  shown: ReadonlySet<string>,
): { kind: SentenceMarkKind; part: number; index: number } | null {
  if (typeof href !== 'string') return null;
  const match = MARK_HREF_RE.exec(href);
  if (!match) return null;
  const kind = match[1] as SentenceMarkKind;
  const part = Number(match[2]);
  const index = Number(match[3]);
  return shown.has(markId(kind, part, index)) ? { kind, part, index } : null;
}

/**
 * GEN-09, GEN-10: the marks per sentence (`part:index`), uncited first. Uncited: factual, not cited, not truncated.
 * Unsupported: a checked record of the same sentence with support `unsupported`. Both inputs must be verified already.
 */
export function sentenceMarkKinds(
  sentences: readonly AnswerSentence[],
  checked: readonly AnswerSentence[],
): Map<string, SentenceMarkKind[]> {
  const unsupported = new Set<string>();
  for (const record of checked) {
    if (record.support === 'unsupported' && !NO_UNCITED_MARK.has(record.kind)) unsupported.add(markKey(record.part, record.index));
  }
  const kinds = new Map<string, SentenceMarkKind[]>();
  const add = (key: string, kind: SentenceMarkKind) => {
    const list = kinds.get(key) ?? [];
    if (!list.includes(kind)) list.push(kind);
    kinds.set(key, list);
  };
  for (const record of sentences) {
    const key = markKey(record.part, record.index);
    if (record.factual && !record.cited && !NO_UNCITED_MARK.has(record.kind)) add(key, 'uncited');
  }
  for (const record of [...sentences, ...checked]) {
    const key = markKey(record.part, record.index);
    if (unsupported.has(key)) add(key, 'unsupported');
  }
  return kinds;
}

function insertionPoint(
  text: string,
  record: AnswerSentence,
  markerEnds: ReadonlyMap<number, number>,
  code: ReadonlyArray<{ start: number; end: number }>,
): number | null {
  if (record.end > text.length || record.start > record.end) return null;
  let at = record.end;
  while (at > record.start && TRAILING_WS.test(text[at - 1]!)) at -= 1;
  for (;;) {
    let next = at;
    while (next < text.length && HORIZONTAL_WS.test(text[next]!)) next += 1;
    const markerEnd = markerEnds.get(next);
    if (markerEnd === undefined) break;
    at = markerEnd;
  }
  if (code.some((range) => range.start < at && at < range.end)) return null;
  return at;
}

/** The marks of one part's records that can be placed: inside prose, never in code, in sentence order. */
export function planSentenceMarks(
  text: string,
  records: readonly AnswerSentence[],
  kinds: ReadonlyMap<string, readonly SentenceMarkKind[]>,
): PlannedMark[] {
  if (typeof text !== 'string' || text.length === 0 || records.length === 0) return [];
  const markerEnds = new Map(findCitationMarkers(text).map((marker) => [marker.start, marker.end] as const));
  const code = codeRanges(text);
  const planned: PlannedMark[] = [];
  for (const record of [...records].sort((a, b) => a.end - b.end || a.index - b.index)) {
    const list = kinds.get(markKey(record.part, record.index));
    if (!list || list.length === 0) continue;
    const at = insertionPoint(text, record, markerEnds, code);
    if (at === null) continue;
    for (const kind of list) {
      planned.push({ id: markId(kind, record.part, record.index), kind, part: record.part, index: record.index, at, table: record.kind === 'table' });
    }
  }
  return planned;
}

function tableSuffix(rest: string): string {
  if (rest.length === 0 || rest.startsWith('\n\n')) return '';
  return rest.startsWith('\n') ? '\n' : '\n\n';
}

/**
 * UI-SPEC 6.2: inserts `[](#mark-…)` links into a raw part text, last record first, before any other rewrite. A table's marks go on
 * their own line under the table. Replacements (verified blocked ranges, 6.5) are applied in the same pass; a mark whose sentence
 * end lies inside a replaced range is dropped.
 */
export function insertSentenceMarks(
  text: string,
  records: readonly AnswerSentence[],
  kinds: ReadonlyMap<string, readonly SentenceMarkKind[]>,
  replacements: readonly TextReplacement[] = [],
): string {
  const blocked = normalizeReplacements(text, replacements);
  const marks = planSentenceMarks(text, records, kinds).filter((mark) => !blocked.some((r) => r.start < mark.at && mark.at <= r.end));
  if (marks.length === 0 && blocked.length === 0) return text;
  const groups = new Map<number, PlannedMark[]>();
  for (const mark of marks) groups.set(mark.at, [...(groups.get(mark.at) ?? []), mark]);
  type Edit = { start: number; end: number; text: string };
  const edits: Edit[] = blocked.map((r) => ({ start: r.start, end: r.end, text: r.text }));
  for (const [at, group] of groups) {
    const links = group.map((mark) => `[](${markHref(mark.kind, mark.part, mark.index)})`).join('');
    const table = group.some((mark) => mark.table);
    edits.push({ start: at, end: at, text: table ? `\n\n${links}${tableSuffix(text.slice(at))}` : `${WORD_JOINER}${links}` });
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** Replacements sorted by start, inside the text, overlapping ones dropped. */
export function normalizeReplacements(text: string, replacements: readonly TextReplacement[]): TextReplacement[] {
  const kept: TextReplacement[] = [];
  for (const r of [...replacements].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (r.start < 0 || r.end > text.length || r.end <= r.start) continue;
    const last = kept[kept.length - 1];
    if (last && r.start < last.end) continue;
    kept.push(r);
  }
  return kept;
}
