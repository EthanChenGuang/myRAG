import type { z } from 'zod/v3';
import type { RetrievalFilterInput, VersionScope } from '../backend/types';
import { SubQuestionsWithFiltersSchema } from '@/lib/rag-eval/contracts.generated';
import { matchRelativeTime } from './rewrite-gate';

/** The generated SubQuestionFilter contract (D-05): strict, every field required and nullable. */
const SUB_QUESTION_SPEC_SCHEMA = SubQuestionsWithFiltersSchema.shape.questions.element;
const FILTER_OR_NULL_SCHEMA = SUB_QUESTION_SPEC_SCHEMA.shape.filter;

export type SubQuestionFilter = NonNullable<z.infer<typeof FILTER_OR_NULL_SCHEMA>>;

/** The field names a decomposer may propose; rendered into the prompt addendum from here. */
export const SUB_QUESTION_FILTER_FIELDS = ['date_range', 'versions', 'scopes', 'doc_types', 'languages'] as const;

/**
 * P-35, T-06.2-69: what decides whether a proposed version scope may widen the search beyond current versions. Absent rules
 * accept no widening version scope.
 */
export interface VersionRules {
  /** RAG_VERSION_SCOPE is effective for this request (effectiveVersionScope would honour a non-current ask). */
  versionScopeEffective: boolean;
  /** The turn is a comparison (R3_COMPARISON) or names a period (isVersionQuestion). */
  versionQuestion: boolean;
  /** The caller's own filter asked for current versions; it wins over any proposal. */
  callerCurrent?: boolean;
}

const YEAR_TOKEN = /(?<![\p{L}\p{N}_-])(?:19|20)\d{2}(?![\p{L}\p{N}_-])/u;

/** P-35: a comparison question (gate rule R3) or a question with a period term (a relative-time term or a standalone year). */
export function isVersionQuestion(text: string, reasons: readonly string[]): boolean {
  if (reasons.includes('R3_COMPARISON') || reasons.includes('R2_RELATIVE_TIME')) return true;
  return matchRelativeTime(text).length > 0 || YEAR_TOKEN.test(text.normalize('NFKC'));
}

/** Per-spec narrowing outcomes (SubQuestionFilterTrace.status without the two the caller sets: dropped_invalid, stripped_switch_off). */
export type NarrowStatus = 'applied' | 'dropped_empty_intersection' | 'dropped_unknown_values';

/** The request tenant's own values (D-06): active scope slugs, doc types of its current ready documents, enabled languages. */
export interface NarrowVocabulary {
  scopes: ReadonlyArray<{ dimension: string; slug: string }>;
  docTypes: readonly string[];
  languages: readonly string[];
}

export interface NarrowResult {
  status: NarrowStatus;
  /** The narrowed filters; the base itself when the proposal was dropped or was null. */
  filters: RetrievalFilterInput | undefined;
  /** The proposal as it was applied (contract shape, narrowed values only); null when nothing was applied. */
  applied: SubQuestionFilter | null;
}

export type ParsedProposal = { ok: true; filter: SubQuestionFilter | null } | { ok: false };

/** D-06: a proposed filter that fails the generated contract (extra keys, wrong types, bad slugs) is dropped by the caller. */
export function parseProposedFilter(raw: unknown): ParsedProposal {
  const parsed = FILTER_OR_NULL_SCHEMA.safeParse(raw);
  if (!parsed.success) return { ok: false };
  return { ok: true, filter: parsed.data ?? null };
}

type FieldOutcome<T> = { kind: 'absent' } | { kind: 'unknown' } | { kind: 'empty' } | { kind: 'narrowed'; value: T };

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Known values first (unknown when none remain), then the base list (empty when none remain); never adds a value. */
function narrowList(proposed: readonly string[] | null, known: ReadonlySet<string>, base: readonly string[] | undefined): FieldOutcome<string[]> {
  if (proposed === null) return { kind: 'absent' };
  const knownValues = unique(proposed).filter((value) => known.has(value));
  if (knownValues.length === 0) return { kind: 'unknown' };
  const value = base === undefined ? knownValues : knownValues.filter((item) => base.includes(item));
  return value.length === 0 ? { kind: 'empty' } : { kind: 'narrowed', value };
}

function narrowDates(
  proposed: SubQuestionFilter['date_range'],
  base: RetrievalFilterInput['dateRange'],
): FieldOutcome<{ from: string; to: string }> {
  if (proposed === null) return { kind: 'absent' };
  const from = base?.from !== undefined && base.from > proposed.from ? base.from : proposed.from;
  const to = base?.to !== undefined && base.to < proposed.to ? base.to : proposed.to;
  return from > to ? { kind: 'empty' } : { kind: 'narrowed', value: { from, to } };
}

type RangeScope = { from?: string; to?: string };

function validRange(range: RangeScope): boolean {
  return range.from !== undefined || range.to !== undefined;
}

/**
 * P-35: the caller's scope bounds the proposal. 'current' narrows a non-current caller scope; 'all' or a range widens a current
 * base only under the rules (else unknown), and never beyond a caller range (ranges intersect, an empty intersection is empty).
 */
function narrowVersions(
  proposed: SubQuestionFilter['versions'],
  base: RetrievalFilterInput['versionScope'],
  rules: VersionRules | undefined,
): FieldOutcome<VersionScope> {
  if (proposed === null || proposed === undefined) return { kind: 'absent' };
  if (rules?.callerCurrent === true) return { kind: 'absent' };
  if (proposed === 'current') return base === undefined ? { kind: 'absent' } : { kind: 'narrowed', value: 'current' };
  if (rules?.versionScopeEffective !== true) return { kind: 'unknown' };
  if (proposed !== 'all') {
    if (!validRange(proposed)) return { kind: 'unknown' };
    if (proposed.from !== undefined && proposed.to !== undefined && proposed.from > proposed.to) return { kind: 'empty' };
  }
  if (base === undefined) {
    if (rules.versionQuestion !== true) return { kind: 'unknown' };
    return { kind: 'narrowed', value: proposed === 'all' ? 'all' : { ...proposed } };
  }
  if (proposed === 'all') return { kind: 'absent' };
  if (base === 'all') return { kind: 'narrowed', value: { ...proposed } };
  const from = [base.from, proposed.from].filter((value): value is string => value !== undefined).sort().at(-1);
  const to = [base.to, proposed.to].filter((value): value is string => value !== undefined).sort()[0];
  if (from !== undefined && to !== undefined && from > to) return { kind: 'empty' };
  return { kind: 'narrowed', value: { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) } };
}

/** RET-11, P-35: the first non-current version scope among a plan's applied sub-question specs; the cache bypasses such a turn. */
export function subQuestionVersionScope(
  specs: ReadonlyArray<{ filter: { versions?: SubQuestionFilter['versions'] } | null }> | null | undefined,
): Exclude<VersionScope, 'current'> | undefined {
  for (const spec of specs ?? []) {
    const versions = spec.filter?.versions;
    if (versions !== null && versions !== undefined && versions !== 'current') return versions === 'all' ? 'all' : { ...versions };
  }
  return undefined;
}

function dimensionOf(tag: string): string {
  const colon = tag.indexOf(':');
  return colon < 0 ? tag : tag.slice(0, colon);
}

/**
 * Scopes (dimension:slug tags; OR within a dimension, AND across dimensions, 3.2 D-39): proposed values the tenant's vocabulary
 * does not hold are dropped; in a dimension the base already filters only base tags survive; a new dimension adds a narrowing.
 */
function narrowScopes(
  proposed: SubQuestionFilter['scopes'],
  known: ReadonlySet<string>,
  base: readonly string[] | undefined,
): FieldOutcome<{ tags: string[]; byDimension: Record<string, string[]> }> {
  if (proposed === null) return { kind: 'absent' };
  const baseTags = base ?? [];
  const baseDimensions = new Set(baseTags.map(dimensionOf));
  const knownTags = unique(Object.entries(proposed).flatMap(([dimension, slugs]) => slugs.map((slug) => `${dimension}:${slug}`))).filter((tag) =>
    known.has(tag),
  );
  if (knownTags.length === 0) return { kind: 'unknown' };
  const proposedDimensions = new Set(knownTags.map(dimensionOf));
  const kept = knownTags.filter((tag) => !baseDimensions.has(dimensionOf(tag)) || baseTags.includes(tag));
  for (const dimension of proposedDimensions) {
    if (!kept.some((tag) => dimensionOf(tag) === dimension)) return { kind: 'empty' };
  }
  const untouched = baseTags.filter((tag) => !proposedDimensions.has(dimensionOf(tag)));
  const byDimension: Record<string, string[]> = {};
  for (const tag of [...kept].sort()) {
    const dimension = dimensionOf(tag);
    (byDimension[dimension] ??= []).push(tag.slice(dimension.length + 1));
  }
  return { kind: 'narrowed', value: { tags: unique([...untouched, ...kept]).sort(), byDimension } };
}

/**
 * D-06: narrows the server-verified base filters with one sub-question's proposal. Pure and intersect-only: date ranges
 * intersect; scope, doc-type and language values outside the tenant's own vocabulary are dropped and the rest intersected with
 * the base. Document ids, sources, invoice fields and both include flags are inherited from the base and never set from the
 * proposal; the tenant scope is not an input. An empty intersection in any field drops the whole proposal (never an empty
 * search); a proposal with only unknown values is dropped as unknown. The result never widens the base, with one gated
 * exception (P-35): versions may add superseded versions of the same tenant only under `versionRules` (narrowVersions).
 */
export function narrowFilters(
  base: RetrievalFilterInput | undefined,
  proposed: SubQuestionFilter | null,
  vocabulary: NarrowVocabulary,
  versionRules?: VersionRules,
): NarrowResult {
  const unchanged = (status: NarrowStatus): NarrowResult => ({ status, filters: base, applied: null });
  if (proposed === null) return unchanged('applied');

  const dates = narrowDates(proposed.date_range, base?.dateRange);
  const docTypes = narrowList(proposed.doc_types, new Set(vocabulary.docTypes), base?.docTypes);
  const languages = narrowList(proposed.languages, new Set(vocabulary.languages), base?.languages);
  const scopes = narrowScopes(proposed.scopes, new Set(vocabulary.scopes.map((value) => `${value.dimension}:${value.slug}`)), base?.scopes);

  const versions = narrowVersions(proposed.versions, base?.versionScope, versionRules);

  const outcomes = [dates, docTypes, languages, scopes, versions];
  if (outcomes.some((outcome) => outcome.kind === 'empty')) return unchanged('dropped_empty_intersection');
  if (!outcomes.some((outcome) => outcome.kind === 'narrowed')) return unchanged('dropped_unknown_values');

  const filters: RetrievalFilterInput = { ...(base ?? {}) };
  const applied: SubQuestionFilter = { date_range: null, scopes: null, doc_types: null, languages: null };
  if (versions.kind === 'narrowed') {
    if (versions.value === 'current') delete filters.versionScope;
    else filters.versionScope = versions.value;
    applied.versions = versions.value;
  }
  if (dates.kind === 'narrowed') {
    filters.dateRange = { ...dates.value, ...(base?.dateRange?.includeUndated === true ? { includeUndated: true } : {}) };
    applied.date_range = { ...dates.value };
  }
  if (docTypes.kind === 'narrowed') {
    filters.docTypes = docTypes.value;
    applied.doc_types = docTypes.value as SubQuestionFilter['doc_types'];
  }
  if (languages.kind === 'narrowed') {
    filters.languages = languages.value;
    applied.languages = languages.value as SubQuestionFilter['languages'];
  }
  if (scopes.kind === 'narrowed') {
    filters.scopes = scopes.value.tags;
    applied.scopes = scopes.value.byDimension;
  }
  return { status: 'applied', filters, applied };
}
