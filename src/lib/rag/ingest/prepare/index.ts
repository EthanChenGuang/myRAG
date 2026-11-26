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
import type { PageBoilerplateMode } from '../config';
import type { TenantRules } from '../rules/load';
import type { ChunkPrepSnapshot } from '../types';
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
  mode: BoilerplateMode;
  /** The tenant's rules for the document's binding; not needed with a snapshot or in mode detect. */
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

/** True when preparing this document starts a worker call: no snapshot, a mode with rules, and at least one tenant line rule. */
export function needsPatternCall(mode: PageBoilerplateMode, rules: TenantRules | null | undefined, snapshot?: ChunkPrepSnapshot | null): boolean {
  if (snapshot || mode === 'off' || mode === 'detect') return false;
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
function mapChunks(chunks: readonly ParseChunk[] | null, removal: BoilerplateRemoval): ParseChunk[] | null {
  if (chunks === null) return null;
  if (removal.keys.length === 0 && removal.lineDigests.length === 0) return chunks as ParseChunk[];
  const map = removalTextMap(removal);
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

function replay(args: PrepareChunkInputArgs, snapshot: ChunkPrepSnapshot): PrepareChunkInputResult {
  const removal = snapshot.boilerplate && !snapshot.truncated ? untagRemoval(snapshot.boilerplate.removedLineKeys) : EMPTY_REMOVAL;
  const replayed = replayRemoval(args.markdown, removal);
  const review = new Set<ReviewCode>(snapshot.warnings.filter(isReviewCode));
  if (replayed.aboveReviewShare) review.add('boilerplate_above_threshold');
  return {
    markdown: replayed.markdown,
    parseChunks: mapChunks(args.parseChunks, removal),
    chunker: args.baseChunker,
    report: replayed.report,
    review: REVIEW_CODES.filter((code) => review.has(code)),
    warnings: snapshot.warnings.filter((code) => !isReviewCode(code)),
    snapshot,
  };
}

/**
 * Cleans one parsed document before chunking. Deterministic for the same inputs; writes no stored object. With `snapshot` set the earlier
 * removal is replayed instead and `rules` is ignored.
 */
export async function prepareChunkInput(args: PrepareChunkInputArgs): Promise<PrepareChunkInputResult> {
  if (args.snapshot) return replay(args, args.snapshot);
  args.signal?.throwIfAborted();
  const { mode } = args;
  const warnings: string[] = [];
  const review = new Set<ReviewCode>();
  const usesRules = mode !== 'detect';
  const rules = usesRules ? (args.rules ?? null) : null;
  if (usesRules && rules?.loadFailed) warnings.push(TENANT_RULES_UNAVAILABLE);

  let lineHits: string[] = [];
  const patterns = usesRules ? lineRules(rules) : [];
  if (patterns.length > 0) {
    const lines = candidateLines(args.markdown);
    if (lines.length > 0) {
      const verdict = await matchTenantLinePatterns(
        { patterns, lines },
        { deadlineMs: args.deadlineMs ?? TENANT_LINE_DEFAULT_DEADLINE_MS, signal: args.signal },
      );
      if (verdict.kind === 'ok') lineHits = [...new Set(verdict.hits.map((hit) => lines[hit.inputIndex]).filter((line): line is string => line !== undefined))];
      else if (verdict.kind === 'timeout') review.add('tenant_pattern_timeout');
      else if (!warnings.includes(TENANT_RULES_UNAVAILABLE)) warnings.push(TENANT_RULES_UNAVAILABLE);
    }
  }

  const cleaned = cleanBoilerplate({
    markdown: args.markdown,
    pageLines: args.pageLines,
    mode,
    lineHits,
    fragmentRules: usesRules ? fragmentRules(rules) : [],
    protectedLines: [],
  });
  for (const code of cleaned.warnings) if (!warnings.includes(code)) warnings.push(code);

  let removal = cleaned.removal;
  let markdown = cleaned.markdown;
  let report = cleaned.report;
  let aboveReviewShare = cleaned.aboveReviewShare;
  let tagged = tagRemoval(removal);
  let truncated = false;
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

  const reviewCodes = REVIEW_CODES.filter((code) => review.has(code));
  const snapshot: ChunkPrepSnapshot = {
    fingerprint: rules && !rules.loadFailed ? rules.fingerprint : NO_RULES_FINGERPRINT,
    boilerplate: {
      mode,
      cleanerVersion: CLEANER_VERSION,
      rulesVersion: boilerplateConfig().rules_version,
      ruleIds: boilerplateRuleIds(rules),
      removedLineKeys: tagged,
    },
    // Review codes that the replay cannot recompute (a worker timeout) are kept with the warning codes.
    warnings: [...warnings, ...reviewCodes.filter((code) => code === 'tenant_pattern_timeout')],
    truncated,
  };
  return {
    markdown,
    parseChunks: mapChunks(args.parseChunks, removal),
    chunker: args.baseChunker,
    report,
    review: reviewCodes,
    warnings,
    snapshot,
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
 * Stores the report under metadata.boilerplate and flags each review code through rag_flag_document_review with the run's tenant key.
 * A flagged document is still published.
 */
export async function applyPrepareOutcome(
  target: PrepareOutcomeTarget,
  outcome: { report: BoilerplateReport | null; review: readonly ReviewCode[] },
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (outcome.report) await target.writer.setFields(target.documentId, { metadata: { boilerplate: outcome.report } });
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
