import type { BoilerplateReport, ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';
import {
  TENANT_LINE_DEFAULT_DEADLINE_MS,
  TENANT_LINE_MATCH_WINDOW,
  matchTenantLinePatterns,
  type TenantLinePatternEntry,
} from '../../patterns/tenant-line-pattern';
import { DOCLING_ARTIFACT, PAGE_TEXTS_ARTIFACT, loadArtifact, type ArtifactContext } from '../artifacts';
import { FENCE, HEADING } from '../chunkers/markdown-sections';
import type { ChunkerConfig } from '../chunkers';
import type { ResolvedSectionRules, SectionHeadingHit } from '../chunkers/rule-sections';
import type { PageBoilerplateMode, SectionRulesMode } from '../config';
import type { LoadedSectionRuleSet, TenantRules } from '../rules/load';
import type { ChunkPrepSectionRulesSnapshot, ChunkPrepSnapshot } from '../types';
import type { IngestWriter } from '../writer';
import {
  CLEANER_VERSION,
  cleanBoilerplate,
  removalTextMap,
  replayRemoval,
  type BoilerplateFragmentRule,
  type BoilerplateMode,
  type BoilerplateRemoval,
} from './boilerplate';
import { boilerplateConfig } from './boilerplate-config';
import { readPageLines, type PageLines } from './page-lines';
import {
  checkSectionRules,
  headingCandidates,
  headingPatterns,
  HEADING_PATTERN_ID_PREFIX,
  hitsOverCap,
  resolveSectionHits,
  resolvedSectionRules,
  sectionCounts,
  type HeadingInput,
  type SectionRuleCounts,
} from './section-hits';

/**
 * The one preparation step between parse and chunk (TPL-02, D-06 to D-11, D-14, D-15). The chunk stage and the re-chunk command call it
 * with values, never with a stage context, so both cut chunks from the same cleaned text. Tenant line patterns run only through the
 * worker wrapper, in one call per document; their matches enter the cleaner as line texts and leave it as digests. With a snapshot of an
 * earlier run, the stored removal record is replayed and neither rules nor the worker are consulted. No log line, warning or snapshot field
 * holds a line or a pattern.
 */

export const TENANT_RULES_UNAVAILABLE = 'tenant_rules_unavailable';
export const BOILERPLATE_SNAPSHOT_TOO_LARGE = 'boilerplate_snapshot_too_large';
export const PREPARE_FAILED = 'prepare_failed';
export const SECTION_RULES_SNAPSHOT_TOO_LARGE = 'section_rules_snapshot_too_large';

export const REVIEW_CODES = ['section_rules_not_satisfied', 'boilerplate_above_threshold', 'tenant_pattern_timeout'] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];

/** Removal records larger than this are not applied at all (T-03.3-1006). */
export const CHUNK_PREP_SNAPSHOT_CAP = { maxEntries: 2000, maxJsonBytes: 256 * 1024 } as const;

/** Rule fingerprint recorded when no tenant rule was consulted (mode detect, a picture). */
export const NO_RULES_FINGERPRINT = '0'.repeat(64);

const MAX_CANDIDATE_LINES = 20_000;
/** Entry tags of ChunkPrepBoilerplateSnapshot.removedLineKeys: one list holds both halves of the removal record. */
const KEY_TAG = 'k:';
const DIGEST_TAG = 'd:';

type ParseChunk = ParseResult['chunks'][number];

export interface PrepareChunkInputArgs {
  markdown: string;
  parseChunks: readonly ParseChunk[] | null;
  pageLines: PageLines | null;
  baseChunker: ChunkerConfig;
  /** The effective cleaning mode; off removes no line (section rules may still run). */
  mode: PageBoilerplateMode;
  /** The effective RAG_SECTION_RULES value; absent means off. */
  sectionRules?: SectionRulesMode;
  /** The tenant's rules for the document's binding; not needed with a snapshot, or in mode detect or off while section rules are off. */
  rules?: TenantRules | null;
  snapshot?: ChunkPrepSnapshot | null;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface PrepareChunkInputResult {
  markdown: string;
  parseChunks: ParseChunk[] | null;
  chunker: ChunkerConfig;
  report: BoilerplateReport;
  review: ReviewCode[];
  warnings: string[];
  snapshot: ChunkPrepSnapshot;
  /** What is stored under metadata.section_rules; null when no rule set applied. */
  sectionRules: SectionRulesReport | null;
}

/** metadata.section_rules: ids, the verdict and integer counts only. */
export interface SectionRulesReport {
  rule_set_id: string;
  version: number;
  satisfied: boolean;
  counts: SectionRuleCounts;
}

const isReviewCode = (code: string): code is ReviewCode => (REVIEW_CODES as readonly string[]).includes(code);

function lineRules(rules: TenantRules | null | undefined): TenantLinePatternEntry[] {
  if (!rules || rules.loadFailed) return [];
  const entries: TenantLinePatternEntry[] = [];
  for (const rule of rules.boilerplateRules) {
    if (rule.kind !== 'line' || rule.pattern === null || rule.flags === null) continue;
    entries.push({ id: rule.id, kind: 'boilerplate_line', pattern: rule.pattern, flags: rule.flags });
  }
  return entries;
}

function fragmentRules(rules: TenantRules | null | undefined): BoilerplateFragmentRule[] {
  if (!rules || rules.loadFailed) return [];
  const out: BoilerplateFragmentRule[] = [];
  for (const rule of rules.boilerplateRules) {
    if (rule.kind === 'fragment' && rule.maxLength !== null && rule.minPageShare !== null) {
      out.push({ max_length: rule.maxLength, min_page_share: rule.minPageShare });
    }
  }
  return out;
}

/** The rule set whose heading patterns apply: loaded, bound to the document and with at least one heading. */
function boundRuleSet(rules: TenantRules | null | undefined): LoadedSectionRuleSet | null {
  if (!rules || rules.loadFailed || !rules.ruleSet || rules.ruleSet.headings.length === 0) return null;
  return rules.ruleSet;
}

/**
 * True when preparing this document starts a worker call: no snapshot, and at least one tenant line rule in a mode with rules or, with
 * section rules on, a bound rule set.
 */
export function needsPatternCall(
  mode: PageBoilerplateMode,
  rules: TenantRules | null | undefined,
  snapshot?: ChunkPrepSnapshot | null,
  sectionRules: SectionRulesMode = 'off',
): boolean {
  if (snapshot) return false;
  if (sectionRules === 'on' && boundRuleSet(rules)) return true;
  if (mode === 'off' || mode === 'detect') return false;
  return lineRules(rules).length > 0;
}

/** True when the mode or the tenant's fragment rules read page structure. */
export function needsPageLines(mode: PageBoilerplateMode, rules: TenantRules | null | undefined): boolean {
  if (mode === 'off') return false;
  if (mode !== 'rules') return true;
  return fragmentRules(rules).length > 0;
}

/** Distinct trimmed lines a tenant line pattern may remove: outside fenced blocks, not table rows, not headings, within the match window. */
export function candidateLines(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split(/\r\n|\r|\n/)) {
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = HEADING.exec(raw);
    if (heading && (heading[2] ?? '').trim() !== '') continue;
    const line = raw.trim();
    if (line === '' || line.startsWith('|') || line.length > TENANT_LINE_MATCH_WINDOW || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_CANDIDATE_LINES) break;
  }
  return out;
}

function tagRemoval(removal: BoilerplateRemoval): string[] {
  return [...removal.keys.map((key) => KEY_TAG + key), ...removal.lineDigests.map((digest) => DIGEST_TAG + digest)];
}

function untagRemoval(entries: readonly string[]): BoilerplateRemoval {
  const keys: string[] = [];
  const lineDigests: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(KEY_TAG)) keys.push(entry.slice(KEY_TAG.length));
    else if (entry.startsWith(DIGEST_TAG)) lineDigests.push(entry.slice(DIGEST_TAG.length));
  }
  return { keys, lineDigests };
}

function overCap(entries: readonly string[]): boolean {
  if (entries.length > CHUNK_PREP_SNAPSHOT_CAP.maxEntries) return true;
  return Buffer.byteLength(JSON.stringify(entries), 'utf8') > CHUNK_PREP_SNAPSHOT_CAP.maxJsonBytes;
}

const EMPTY_REMOVAL: BoilerplateRemoval = { keys: [], lineDigests: [] };

/** The removal applied to every text field of the parser's chunks; emptied headings and chunks with no text left are dropped. */
function mapChunks(chunks: readonly ParseChunk[] | null, removal: BoilerplateRemoval, protectedLines: readonly string[] = []): ParseChunk[] | null {
  if (chunks === null) return null;
  if (removal.keys.length === 0 && removal.lineDigests.length === 0) return chunks as ParseChunk[];
  const map = removalTextMap(removal, protectedLines);
  const out: ParseChunk[] = [];
  for (const chunk of chunks) {
    const text = map(chunk.text);
    if (text.trim() === '') continue;
    out.push({
      ...chunk,
      text,
      contextualized_text: map(chunk.contextualized_text),
      headings: chunk.headings.map(map).filter((heading) => heading.trim() !== ''),
      table_header: typeof chunk.table_header === 'string' ? map(chunk.table_header) : chunk.table_header,
    });
  }
  return out;
}

function boilerplateRuleIds(rules: TenantRules | null | undefined): Array<{ id: string; version: number }> {
  if (!rules || rules.loadFailed) return [];
  return rules.ruleIds.filter((entry) => entry.kind === 'boilerplate_rule').map((entry) => ({ id: entry.id, version: entry.version }));
}

function resolvedOf(section: ChunkPrepSectionRulesSnapshot): ResolvedSectionRules {
  return {
    rule_set_id: section.ruleSetId,
    version: section.ruleSetVersion,
    skip_toc: section.toc.skip,
    toc_min_run: section.toc.minRunLines,
    hits: section.headingHits,
  };
}

/** The chunker a section-rules snapshot selects: the rule-driven one when the rule set was satisfied, else the profile's own object. */
function chunkerOf(base: ChunkerConfig, section: ChunkPrepSectionRulesSnapshot | undefined): ChunkerConfig {
  return section?.satisfied ? { ...base, kind: 'rule_sections', section_rules: resolvedOf(section) } : base;
}

function sectionReportOf(markdown: string, section: ChunkPrepSectionRulesSnapshot): SectionRulesReport {
  return { rule_set_id: section.ruleSetId, version: section.ruleSetVersion, satisfied: section.satisfied, counts: sectionCounts(markdown, resolvedOf(section)) };
}

function replay(args: PrepareChunkInputArgs, snapshot: ChunkPrepSnapshot): PrepareChunkInputResult {
  const section = snapshot.sectionRules;
  const protectedLines = section ? Object.keys(section.headingHits) : [];
  const removal = snapshot.boilerplate && !snapshot.truncated ? untagRemoval(snapshot.boilerplate.removedLineKeys) : EMPTY_REMOVAL;
  const replayed = replayRemoval(args.markdown, removal, protectedLines);
  const review = new Set<ReviewCode>(snapshot.warnings.filter(isReviewCode));
  if (replayed.aboveReviewShare) review.add('boilerplate_above_threshold');
  // A rule set that could not be judged (worker timeout or failure) is not reported as unsatisfied, on the first run or on replay.
  if (section && !section.satisfied && !snapshot.warnings.includes('tenant_pattern_timeout') && !snapshot.warnings.includes(TENANT_RULES_UNAVAILABLE)) {
    review.add('section_rules_not_satisfied');
  }
  return {
    markdown: replayed.markdown,
    parseChunks: mapChunks(args.parseChunks, removal, protectedLines),
    chunker: chunkerOf(args.baseChunker, section),
    report: replayed.report,
    review: REVIEW_CODES.filter((code) => review.has(code)),
    warnings: snapshot.warnings.filter((code) => !isReviewCode(code)),
    snapshot,
    sectionRules: section ? sectionReportOf(replayed.markdown, section) : null,
  };
}

/** The worker request lines: the boilerplate candidates first (unchanged from cleaning alone), then heading-only texts, one entry per text. */
function requestLines(markdown: string, withLines: boolean, ruleSet: LoadedSectionRuleSet | null): { lines: string[]; lineInputs: number; headings: HeadingInput[] } {
  const lines = withLines ? candidateLines(markdown) : [];
  const lineInputs = lines.length;
  const headings: HeadingInput[] = [];
  if (ruleSet) {
    const indexOf = new Map<string, number>();
    lines.forEach((line, index) => indexOf.set(line, index));
    for (const candidate of headingCandidates(markdown)) {
      let input = indexOf.get(candidate.text);
      if (input === undefined) {
        if (lines.length >= MAX_CANDIDATE_LINES) continue;
        input = lines.push(candidate.text) - 1;
        indexOf.set(candidate.text, input);
      }
      headings.push({ input, key: candidate.key });
    }
  }
  return { lines, lineInputs, headings };
}

/**
 * Prepares one parsed document before chunking: page boilerplate cleaning (mode not off) and section rules (sectionRules on with a bound
 * rule set). Deterministic for the same inputs; writes no stored object. One worker call serves both pattern kinds. Lines that are
 * headings of the bound rule set are never removed. With `snapshot` set the earlier result is replayed instead and `rules` is ignored.
 */
export async function prepareChunkInput(args: PrepareChunkInputArgs): Promise<PrepareChunkInputResult> {
  if (args.snapshot) return replay(args, args.snapshot);
  args.signal?.throwIfAborted();
  const { mode } = args;
  const warnings: string[] = [];
  const review = new Set<ReviewCode>();
  const cleaning = mode !== 'off';
  const usesRules = cleaning && mode !== 'detect';
  const ruleSet = args.sectionRules === 'on' ? boundRuleSet(args.rules) : null;
  const rules = usesRules ? (args.rules ?? null) : null;
  if ((usesRules || args.sectionRules === 'on') && args.rules?.loadFailed) warnings.push(TENANT_RULES_UNAVAILABLE);

  let lineHits: string[] = [];
  let hits: Record<string, SectionHeadingHit> = {};
  let judged = ruleSet !== null;
  const linePatterns = usesRules ? lineRules(rules) : [];
  const patterns = [...(ruleSet ? headingPatterns(ruleSet) : []), ...linePatterns];
  if (patterns.length > 0) {
    const { lines, lineInputs, headings } = requestLines(args.markdown, linePatterns.length > 0, ruleSet);
    if (lines.length > 0) {
      const verdict = await matchTenantLinePatterns(
        { patterns, lines },
        { deadlineMs: args.deadlineMs ?? TENANT_LINE_DEFAULT_DEADLINE_MS, signal: args.signal },
      );
      if (verdict.kind === 'ok') {
        const ruled = verdict.hits.filter((hit) => hit.inputIndex < lineInputs && !hit.patternId.startsWith(HEADING_PATTERN_ID_PREFIX));
        lineHits = [...new Set(ruled.map((hit) => lines[hit.inputIndex]).filter((line): line is string => line !== undefined))];
        if (ruleSet) hits = resolveSectionHits({ candidates: headings, ruleSet, verdict });
      } else {
        judged = false;
        if (verdict.kind === 'timeout') review.add('tenant_pattern_timeout');
        else if (!warnings.includes(TENANT_RULES_UNAVAILABLE)) warnings.push(TENANT_RULES_UNAVAILABLE);
      }
    }
  }
  if (ruleSet && hitsOverCap(hits)) {
    hits = {};
    warnings.push(SECTION_RULES_SNAPSHOT_TOO_LARGE);
  }
  const protectedLines = Object.keys(hits);

  let removal = EMPTY_REMOVAL;
  let markdown = args.markdown;
  let report: BoilerplateReport;
  let tagged: string[] = [];
  let truncated = false;
  if (cleaning) {
    const cleaned = cleanBoilerplate({
      markdown: args.markdown,
      pageLines: args.pageLines,
      mode,
      lineHits,
      fragmentRules: usesRules ? fragmentRules(rules) : [],
      protectedLines,
    });
    for (const code of cleaned.warnings) if (!warnings.includes(code)) warnings.push(code);
    removal = cleaned.removal;
    markdown = cleaned.markdown;
    report = cleaned.report;
    let aboveReviewShare = cleaned.aboveReviewShare;
    tagged = tagRemoval(removal);
    if (overCap(tagged)) {
      truncated = true;
      removal = EMPTY_REMOVAL;
      tagged = [];
      const unchanged = replayRemoval(args.markdown, EMPTY_REMOVAL);
      markdown = args.markdown;
      report = unchanged.report;
      aboveReviewShare = false;
      warnings.push(BOILERPLATE_SNAPSHOT_TOO_LARGE);
    }
    if (aboveReviewShare) review.add('boilerplate_above_threshold');
  } else {
    report = replayRemoval(args.markdown, EMPTY_REMOVAL).report;
  }

  let chunker = args.baseChunker;
  let sectionSnapshot: ChunkPrepSectionRulesSnapshot | undefined;
  let sectionReport: SectionRulesReport | null = null;
  if (ruleSet) {
    const resolved = resolvedSectionRules(ruleSet, hits);
    const check = checkSectionRules(markdown, resolved, ruleSet);
    const satisfied = judged && check.satisfied;
    if (judged && !satisfied) review.add('section_rules_not_satisfied');
    sectionSnapshot = {
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
      toc: { skip: ruleSet.skipToc, minRunLines: ruleSet.tocMinRun },
      headingHits: hits,
      satisfied,
    };
    chunker = chunkerOf(args.baseChunker, sectionSnapshot);
    sectionReport = { rule_set_id: ruleSet.id, version: ruleSet.version, satisfied, counts: check.counts };
  }

  const reviewCodes = REVIEW_CODES.filter((code) => review.has(code));
  const consulted = usesRules ? rules : ruleSet ? (args.rules ?? null) : null;
  const snapshot: ChunkPrepSnapshot = {
    fingerprint: consulted && !consulted.loadFailed ? consulted.fingerprint : NO_RULES_FINGERPRINT,
    ...(cleaning
      ? {
          boilerplate: {
            mode,
            cleanerVersion: CLEANER_VERSION,
            rulesVersion: boilerplateConfig().rules_version,
            ruleIds: boilerplateRuleIds(rules),
            removedLineKeys: tagged,
          },
        }
      : {}),
    ...(sectionSnapshot ? { sectionRules: sectionSnapshot } : {}),
    // Review codes that the replay cannot recompute (a worker timeout) are kept with the warning codes.
    warnings: [...warnings, ...reviewCodes.filter((code) => code === 'tenant_pattern_timeout')],
    truncated,
  };
  return {
    markdown,
    parseChunks: mapChunks(args.parseChunks, removal, protectedLines),
    chunker,
    report,
    review: reviewCodes,
    warnings,
    snapshot,
    sectionRules: sectionReport,
  };
}

/** The snapshot of a document that is not cleaned (a picture): mode and versions only, so its fingerprint carries the part. */
export function uncleanedSnapshot(mode: BoilerplateMode): ChunkPrepSnapshot {
  return {
    fingerprint: NO_RULES_FINGERPRINT,
    boilerplate: { mode, cleanerVersion: CLEANER_VERSION, rulesVersion: boilerplateConfig().rules_version, ruleIds: [], removedLineKeys: [] },
    warnings: [],
    truncated: false,
  };
}

async function pageLinesOf(context: ArtifactContext, name: string): Promise<PageLines | null> {
  const stored = await loadArtifact(context, name);
  if (!stored) return null;
  try {
    return readPageLines(JSON.parse(new TextDecoder('utf-8').decode(stored.bytes)));
  } catch {
    return null;
  }
}

/**
 * Page structure of the version: its docling.json, else its page-text artifact, else the page-text artifact of the version a type change
 * reuses, else null. A missing object is null; any other store failure is rethrown.
 */
export async function loadPageLines(context: ArtifactContext, options: { reuseOfVersion?: number | null } = {}): Promise<PageLines | null> {
  const docling = await pageLinesOf(context, DOCLING_ARTIFACT);
  if (docling) return docling;
  const own = await pageLinesOf(context, PAGE_TEXTS_ARTIFACT);
  if (own) return own;
  const reused = options.reuseOfVersion;
  if (reused === null || reused === undefined || !context.document || reused === context.document.version) return null;
  const earlier: ArtifactContext = { ...context, document: { lineageId: context.document.lineageId, version: reused }, state: { artifacts: {} } };
  return pageLinesOf(earlier, PAGE_TEXTS_ARTIFACT);
}

export interface PrepareOutcomeTarget {
  writer: Pick<IngestWriter, 'setFields'>;
  db: RpcClient | null;
  documentId: string;
  tenantKey: string;
}

/**
 * Stores the report under metadata.boilerplate and the section-rules verdict under metadata.section_rules, and flags each review code through rag_flag_document_review with the run's tenant key.
 * A flagged document is still published.
 */
export async function applyPrepareOutcome(
  target: PrepareOutcomeTarget,
  outcome: { report: BoilerplateReport | null; review: readonly ReviewCode[]; sectionRules?: SectionRulesReport | null },
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const metadata: Record<string, unknown> = {};
  if (outcome.report) metadata.boilerplate = outcome.report;
  if (outcome.sectionRules) metadata.section_rules = outcome.sectionRules;
  if (Object.keys(metadata).length > 0) await target.writer.setFields(target.documentId, { metadata });
  if (outcome.review.length === 0) return;
  if (!target.db) throw new Error('[Ingest] review flag: database unavailable');
  for (const reason of outcome.review) {
    const request = target.db.rpc('rag_flag_document_review', { p_document_id: target.documentId, p_tenant_key: target.tenantKey, p_reason: reason });
    const response = await (options.signal ? request.abortSignal(options.signal) : request);
    if (response.error) {
      console.error('[Ingest] review flag failed', { code: response.error.code ?? null, reason });
      throw new Error('[Ingest] review flag failed');
    }
  }
}
