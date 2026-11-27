import { isMultiTenant } from '@/lib/deployment-mode';
import { readAnswerConfig } from '../generation/answer-config';
import { detectLanguage } from '../lang/detect';
import type { TenantScope } from '../tenant/scope';
import { readSecurityConfig, type InjectionCheckMode, type SecurityConfig } from './config';
import { detectorsConfigVersion, loadInjectionDetectorConfig, type Detector, type DetectorProfile } from './detectors';
import { injectionRulesVersion, scanText } from './injection-rules';
import { lakeraAllowed } from './lakera';
import type { PromptGuardItem, PromptGuardOutcome } from './prompt-guard-client';
import { buildSecurityEvent, recordSecurityEvents, type SecurityEvent } from './security-events';
import { createVerdictCache, verdictCacheKey, type VerdictCache } from './verdict-cache';
import type { InjectionItemRecord, InjectionSummary, Profile, ReferencedSection, ReferencedState } from '../types';

export type ActiveInjectionMode = Exclude<InjectionCheckMode, 'off'>;

/** Time added to the configured stage budget so the stage race never pre-empts the rules or a later inner ML deadline. */
export const INJECTION_STAGE_GUARD_MS = 250;

export interface InjectionCheckItem {
  /** `chunk:<chunk id>` or `ref:<section index>`. */
  key: string;
  kind: 'chunk' | 'reference';
  documentId: string;
  chunkIds: string[];
  text: string;
}

export interface InjectionVerdict {
  flagged: boolean;
  ruleIds: string[];
  /** The matcher threw for this item; it counts as unflagged for this request. */
  error: boolean;
  /** The detectors that flagged the item; absent means the rules. */
  sources?: InjectionDetectorId[];
}

export type InjectionVerdicts = ReadonlyMap<string, InjectionVerdict>;

export interface ItemCandidate {
  chunk_id: string;
  document_id: string;
  content: string;
  metadata?: Record<string, any> | null;
}

export function chunkKey(chunkId: string): string {
  return `chunk:${chunkId}`;
}

function referenceKey(index: number): string {
  return `ref:${index}`;
}

/** The texts the generator would see: chunk content plus an image caption, and referenced document sections. */
export function injectionItems(
  candidates: readonly ItemCandidate[],
  chunkMetadata: ReadonlyMap<string, Record<string, any> | null> | null,
  referenced: ReferencedState | null,
): InjectionCheckItem[] {
  const items: InjectionCheckItem[] = [];
  referenced?.sections?.forEach((section, index) => {
    if (section.missing || !section.text) return;
    items.push({ key: referenceKey(index), kind: 'reference', documentId: section.documentId, chunkIds: [...section.chunkIds], text: section.text });
  });
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.chunk_id)) continue;
    seen.add(candidate.chunk_id);
    const caption = candidate.metadata?.image_context ?? chunkMetadata?.get(candidate.chunk_id)?.image_context;
    const text = typeof caption === 'string' && caption !== '' ? `${candidate.content}\n${caption}` : candidate.content;
    items.push({ key: chunkKey(candidate.chunk_id), kind: 'chunk', documentId: candidate.document_id, chunkIds: [candidate.chunk_id], text });
  }
  return items;
}

/** Document id (one row per document version) to the rule ids an admin released that version for. */
export type ReleasedRules = ReadonlyMap<string, ReadonlySet<string>>;

interface ReleasedRow {
  id: string;
  metadata?: Record<string, unknown> | null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;
}

/**
 * The released rule ids per document version, read only from document rows the caller already loaded under its own
 * scope (fetchAssemblyRows or the overview lookup); never a lookup by id. A version counts as released only when
 * metadata.quarantine.released_at is set; the ids are released_rule_ids, else rule_ids.
 */
export function releasedRulesFromRows(rows: Iterable<ReleasedRow> | ReadonlyMap<string, ReleasedRow> | null | undefined): ReleasedRules {
  const released = new Map<string, ReadonlySet<string>>();
  if (!rows) return released;
  const list = rows instanceof Map ? rows.values() : (rows as Iterable<ReleasedRow>);
  for (const row of list) {
    const raw = row?.metadata?.quarantine;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const quarantine = raw as Record<string, unknown>;
    if (typeof quarantine.released_at !== 'string' || quarantine.released_at === '') continue;
    const ids = stringList(quarantine.released_rule_ids) ?? stringList(quarantine.rule_ids) ?? [];
    if (ids.length > 0 && typeof row.id === 'string') released.set(row.id, new Set(ids));
  }
  return released;
}

export type InjectionDetectorId = 'rules' | 'prompt_guard' | 'lakera';

const RULES_ONLY_PROFILES: readonly Profile[] = ['voice', 'media'];

export type MlDetectorId = Exclude<InjectionDetectorId, 'rules'>;

const WIRED_ML_DETECTORS: readonly MlDetectorId[] = ['prompt_guard', 'lakera'];

/** The detectors a profile runs: voice and media run the rules only whatever the ML switches say (D-09, A-11). */
export function injectionDetectorsFor(profile: Profile, config: Pick<SecurityConfig, 'promptGuard' | 'lakera'>): InjectionDetectorId[] {
  if (RULES_ONLY_PROFILES.includes(profile)) return ['rules'];
  const enabled = WIRED_ML_DETECTORS.filter((id) => (id === 'prompt_guard' ? config.promptGuard : config.lakera));
  return ['rules', ...enabled];
}

/** The eval trace's security block while the injection check is on (D-18); null when it is off. */
export function injectionTraceVersions(env: Record<string, string | undefined> = process.env): { rules_version: string; detectors_version: string } | null {
  if (readSecurityConfig(env).injectionCheck === 'off') return null;
  return { rules_version: injectionRulesVersion(), detectors_version: detectorsConfigVersion() };
}

/** Detector versions recorded on the stage entry, e.g. rules@8eade169ab89 and, with an ML detector, detectors@<config version>. */
export function injectionVersions(detectors: readonly InjectionDetectorId[]): string[] {
  const versions = detectors.includes('rules') ? [`rules@${injectionRulesVersion()}`] : [];
  if (detectors.some((id) => id !== 'rules')) versions.push(`detectors@${detectorsConfigVersion()}`);
  return versions;
}

/** Runs the rules on every item synchronously; never awaits, so a stage timeout cannot skip it. */
export function runInjectionCheck(input: {
  items: readonly InjectionCheckItem[];
  mode: ActiveInjectionMode;
  /** Rule ids ignored for the named document version only; other rules still apply. */
  released?: ReleasedRules;
}): InjectionVerdicts {
  const verdicts = new Map<string, InjectionVerdict>();
  for (const item of input.items) {
    try {
      const scan = scanText(item.text);
      const exempt = input.released?.get(item.documentId);
      const ruleIds = exempt ? scan.rule_ids.filter((ruleId) => !exempt.has(ruleId)) : [...scan.rule_ids];
      verdicts.set(item.key, { flagged: ruleIds.length > 0, ruleIds, error: false });
    } catch {
      console.warn('[RAG Security] Injection rules failed for one item, treated as unflagged', {
        chunkIds: item.chunkIds,
        documentId: item.documentId,
      });
      verdicts.set(item.key, { flagged: false, ruleIds: [], error: true });
    }
  }
  return verdicts;
}

export interface InjectionMarks {
  /** Flagged chunk ids, rendered after unflagged chunks and marked flagged. */
  chunkIds: ReadonlySet<string>;
  /** Indexes of flagged referenced sections, marked flagged. */
  sectionIndexes: ReadonlySet<number>;
}

export interface InjectionApplied<C extends ItemCandidate> {
  candidates: C[];
  referenced: ReferencedState | null;
  summary: InjectionSummary;
  /** Stage counts: items checked, flagged, dropped and downweighted, in total and per detector (`rules_*`). */
  counts: Record<string, number>;
  /** Set for downweight only. */
  marks: InjectionMarks | null;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function dropReferences(referenced: ReferencedState, dropped: ReadonlySet<number>, render: (section: ReferencedSection) => string): ReferencedState {
  const sections = referenced.sections ?? [];
  const kept = sections.filter((_, index) => !dropped.has(index));
  const surviving = new Set(kept.map((section) => section.documentId));
  const removed = new Set(sections.filter((_, index) => dropped.has(index)).map((section) => section.documentId));
  return {
    usedDocuments: referenced.usedDocuments.filter((doc) => !removed.has(doc.id) || surviving.has(doc.id)),
    context: kept.map(render).join(''),
    sections: kept,
  };
}

/**
 * flag records only; drop removes flagged candidates and referenced sections (and the referenced document's
 * UsedDocument); downweight removes nothing and returns the marks the renderer uses to move and mark them.
 */
export function applyInjectionAction<C extends ItemCandidate>(input: {
  candidates: readonly C[];
  referenced: ReferencedState | null;
  items: readonly InjectionCheckItem[];
  verdicts: InjectionVerdicts;
  mode: ActiveInjectionMode;
  renderSection: (section: ReferencedSection) => string;
  /** Document id to filename, from document rows already read under the caller's scope. */
  documentNames?: ReadonlyMap<string, string>;
}): InjectionApplied<C> {
  const { items, verdicts, mode } = input;
  const flaggedChunks = new Set<string>();
  const flaggedSections = new Set<number>();
  const flaggedReferenceDocs = new Set<string>();
  const ruleIds = new Set<string>();
  for (const item of items) {
    const verdict = verdicts.get(item.key);
    if (!verdict?.flagged) continue;
    for (const ruleId of verdict.ruleIds) ruleIds.add(ruleId);
    if (item.kind === 'chunk') flaggedChunks.add(item.chunkIds[0]!);
    else {
      flaggedSections.add(Number(item.key.slice('ref:'.length)));
      flaggedReferenceDocs.add(item.documentId);
    }
  }
  const records: InjectionItemRecord[] = items.map((item) => {
    const verdict = verdicts.get(item.key);
    const flaggedItem = verdict?.flagged === true;
    const documentName = input.documentNames?.get(item.documentId);
    return {
      kind: item.kind,
      chunkIds: [...item.chunkIds],
      documentId: item.documentId,
      ...(documentName ? { documentName } : {}),
      flagged: flaggedItem,
      detectors: flaggedItem ? unique(verdict.sources ?? ['rules']) : [],
      ruleIds: flaggedItem ? unique(verdict.ruleIds) : [],
    };
  });
  const sectionChunkIds = [...flaggedSections].flatMap((index) => input.referenced?.sections?.[index]?.chunkIds ?? []);
  const flagged = flaggedChunks.size > 0 || flaggedSections.size > 0;

  let candidates = [...input.candidates];
  let referenced = input.referenced;
  let dropped: string[] = [];
  let downweighted: string[] = [];
  let marks: InjectionMarks | null = null;

  if (mode === 'drop' && flagged) {
    candidates = candidates.filter((candidate) => !flaggedChunks.has(candidate.chunk_id));
    if (referenced && flaggedSections.size > 0) referenced = dropReferences(referenced, flaggedSections, input.renderSection);
    dropped = unique([...flaggedChunks, ...sectionChunkIds]);
  } else if (mode === 'downweight' && flagged) {
    downweighted = unique(flaggedChunks);
    marks = { chunkIds: flaggedChunks, sectionIndexes: flaggedSections };
  }

  const flaggedItems = flaggedChunks.size + flaggedSections.size;
  const dropCount = mode === 'drop' ? flaggedItems : 0;
  const downweightCount = mode === 'downweight' ? flaggedItems : 0;
  const rulesFlagged = items.filter((item) => {
    const verdict = verdicts.get(item.key);
    return verdict?.flagged === true && (verdict.sources ?? ['rules']).includes('rules');
  }).length;
  return {
    candidates,
    referenced,
    marks,
    counts: {
      checked: items.length,
      flagged: flaggedItems,
      dropped: dropCount,
      downweighted: downweightCount,
      rules_checked: items.length,
      rules_flagged: rulesFlagged,
      rules_dropped: mode === 'drop' ? rulesFlagged : 0,
      rules_downweighted: mode === 'downweight' ? rulesFlagged : 0,
    },
    summary: {
      mode,
      checkedCount: items.length,
      flaggedChunkIds: unique([...flaggedChunks, ...sectionChunkIds]),
      flaggedReferenceIds: unique(flaggedReferenceDocs),
      droppedChunkIds: dropped,
      downweightedChunkIds: downweighted,
      droppedReferenceIds: mode === 'drop' ? unique(flaggedReferenceDocs) : [],
      ruleIds: unique(ruleIds),
      detectorsUnavailable: [],
      flagged,
      items: records,
    },
  };
}

/** Document id to uploader (documents.user_id) from rows that carry the column; rows read without it add nothing. */
export function uploadersFromRows(
  rows: Iterable<{ id: string; user_id?: string | null }> | ReadonlyMap<string, { id: string; user_id?: string | null }> | null | undefined,
): Map<string, string | null> {
  const uploaders = new Map<string, string | null>();
  if (!rows) return uploaders;
  const list = rows instanceof Map ? rows.values() : (rows as Iterable<{ id: string; user_id?: string | null }>);
  for (const row of list) {
    if (!row || typeof row.id !== 'string' || !Object.prototype.hasOwnProperty.call(row, 'user_id')) continue;
    uploaders.set(row.id, typeof row.user_id === 'string' ? row.user_id : null);
  }
  return uploaders;
}

/** RAG_SECURITY_EVENTS, read at call time; a configuration error reads as off. */
export function securityEventsOn(): boolean {
  try {
    return readAnswerConfig().securityEvents;
  } catch {
    return false;
  }
}

const STAGE_ACTIONS: Record<ActiveInjectionMode, SecurityEvent['action']> = { flag: 'detected', drop: 'dropped', downweight: 'downweighted' };

/**
 * D-43: one retrieval_injection event per flagged item, with the action the stage took, the flagging detector (rules when they
 * matched), the rule ids, the item's document and first chunk, and the uploader from the document rows. Ids only.
 */
export function injectionSecurityEvents(
  summary: InjectionSummary,
  context: { tenantKey: string; traceId: string | null; uploaders?: ReadonlyMap<string, string | null> },
): SecurityEvent[] {
  const action = STAGE_ACTIONS[summary.mode];
  const events: SecurityEvent[] = [];
  for (const item of summary.items ?? []) {
    if (!item.flagged) continue;
    const detector = item.detectors.includes('rules') ? 'rules' : (item.detectors[0] ?? 'rules');
    events.push(
      buildSecurityEvent({
        tenantKey: context.tenantKey,
        source: 'retrieval_injection',
        action,
        detector,
        ruleIds: item.ruleIds,
        documentId: item.documentId,
        chunkId: item.chunkIds[0] ?? null,
        uploaderId: context.uploaders?.get(item.documentId) ?? null,
        traceId: context.traceId,
      }),
    );
  }
  return events;
}

/**
 * Builds the request's retrieval_injection events and records them in one call after the response (D-43); eval runs record
 * nothing, so a fixture run never counts towards an uploader alert or hold. Returns the events for the log line.
 */
export function recordInjectionEvents(
  summary: InjectionSummary,
  context: { tenantKey: string; traceId: string | null; uploaders?: ReadonlyMap<string, string | null>; profile: Profile },
): SecurityEvent[] {
  const events = injectionSecurityEvents(summary, context);
  if (events.length > 0 && context.profile !== 'eval') recordSecurityEvents({ tenantKey: context.tenantKey, events, traceId: context.traceId });
  return events;
}

/** The security part of the injection log line, present only while RAG_SECURITY_EVENTS is on: tenant and per-event ids (D-44). */
export interface InjectionLogSecurity {
  tenant: string;
  events: readonly SecurityEvent[];
}

/** One summary line per request: ids, rule ids and counts only, never chunk or query text. */
export function logInjectionSummary(
  summary: InjectionSummary,
  counts: Record<string, number>,
  extra: { traceId: string; stalled?: boolean; security?: InjectionLogSecurity },
): void {
  console.log('[RAG Security] Injection check', {
    traceId: extra.traceId,
    mode: summary.mode,
    counts,
    ruleIds: summary.ruleIds,
    flaggedChunkIds: summary.flaggedChunkIds,
    flaggedReferenceIds: summary.flaggedReferenceIds,
    droppedChunkIds: summary.droppedChunkIds,
    ...(summary.detectorsUnavailable.length > 0 ? { detectorsUnavailable: summary.detectorsUnavailable } : {}),
    ...(summary.detectorsDisabled ? { detectorsDisabled: summary.detectorsDisabled } : {}),
    ...(summary.detectorFailures ? { detectorFailures: summary.detectorFailures } : {}),
    ...(extra.stalled ? { stalled: true } : {}),
    ...(extra.security
      ? {
          tenant: extra.security.tenant,
          events: extra.security.events.map((event) => ({
            document: event.document_id,
            chunk: event.chunk_id,
            uploader: event.uploader_id,
            detector: event.detector,
            action: event.action,
          })),
        }
      : {}),
  });
}

let stallForTests: (() => Promise<void>) | null = null;

/** Test hook: delays the end of the stage after the rules ran, to exercise the stall fail-safe. */
export function setInjectionStallForTests(stall: (() => Promise<void>) | null): void {
  stallForTests = stall;
}

/** The part of the stage after the rules; plan 05.1-21 adds the ML detectors here under their own deadline. */
export function afterRules<T>(value: T): T | Promise<T> {
  if (!stallForTests) return value;
  return stallForTests().then(() => value);
}

// ---------------------------------------------------------------------------------------------------------------
// ML detectors (D-07, D-09, A-3, A-9, A-11, A-12): run in parallel on the items the rules did not flag, under an
// inner deadline below the stage race, with every failure reported as a value.

export type PromptGuardClassifier = (items: PromptGuardItem[], opts: { signal?: AbortSignal; timeoutMs: number }) => Promise<PromptGuardOutcome>;

export interface InjectionDetectorsInput {
  items: readonly InjectionCheckItem[];
  /** The rules verdicts; an item they flagged is never sent to an ML detector. */
  verdicts: InjectionVerdicts;
  profile: Profile;
  security: SecurityConfig;
  /** Keys the verdict cache; without a tenant no ML detector runs. */
  scope: TenantScope | null;
  traceId: string | null;
  /** The stage signal. */
  signal: AbortSignal;
  /** The configured stage budget; the ML fan-out stops at budget minus inner_reserve_ms. */
  budgetMs: number;
  lakeraDetector: () => Detector;
  promptGuardClassifier: PromptGuardClassifier;
  /** Defaults to the real deployment-mode resolver. */
  multiTenant?: () => boolean;
}

export interface InjectionDetectorsRun {
  verdicts: InjectionVerdicts;
  /** ML detectors that report counts for this request. */
  reported: MlDetectorId[];
  counts: Record<string, number>;
  /** Detectors that failed while an unflagged item needed them; sets degraded / injection_check_detector_unavailable. */
  unavailable: MlDetectorId[];
  /** Detectors that were configured but refused or not usable for this request, with the reason. */
  disabled: Partial<Record<MlDetectorId, string>>;
  /** The first failure reason of each unavailable detector. */
  failures: Partial<Record<MlDetectorId, string>>;
}

/** Background warming of the Prompt Guard cache is bounded by this ceiling and never awaited by a request. */
export const PROMPT_GUARD_WARM_TIMEOUT_MS = 60000;

const ML_PROFILES: readonly DetectorProfile[] = ['chat', 'embed', 'eval'];

let verdictCache: VerdictCache | null = null;
let warmInFlight: Promise<void> | null = null;

function cache(): VerdictCache {
  if (!verdictCache) verdictCache = createVerdictCache({ maxEntries: loadInjectionDetectorConfig().cache.max_entries });
  return verdictCache;
}

export function resetInjectionDetectorsForTests(): void {
  verdictCache = null;
  warmInFlight = null;
}

/** Resolves when the current background warm batch, if any, has finished. */
export async function injectionWarmIdleForTests(): Promise<void> {
  while (warmInFlight) await warmInFlight;
}

function promptGuardVersion(): string {
  const config = loadInjectionDetectorConfig().prompt_guard;
  return `${config.model_id}@${config.revision}`;
}

function isMlProfile(profile: Profile): profile is DetectorProfile {
  return (ML_PROFILES as readonly string[]).includes(profile);
}

type ScopedInput = InjectionDetectorsInput & { scope: TenantScope };

type ItemOutcome = { kind: 'verdict'; flagged: boolean } | { kind: 'unavailable'; reason: string };

interface DetectorState {
  outcomes: Map<string, ItemOutcome>;
  counts: { checked: number; unavailable: number; unsupported_language: number; cache_hit: number; cache_miss: number };
  disabledReason: string | null;
  unavailableReason: string | null;
  warmDropped: number;
  /** Items sent inline and still awaited; marked unavailable when the inner deadline fires first. */
  inFlight: InjectionCheckItem[];
}

function newState(): DetectorState {
  return {
    outcomes: new Map(),
    counts: { checked: 0, unavailable: 0, unsupported_language: 0, cache_hit: 0, cache_miss: 0 },
    disabledReason: null,
    unavailableReason: null,
    warmDropped: 0,
    inFlight: [],
  };
}

function abortPromise(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

/** Cache lookups first; returns the items still needing a call. */
function lookup(state: DetectorState, pending: readonly InjectionCheckItem[], keyOf: (item: InjectionCheckItem) => string): InjectionCheckItem[] {
  const misses: InjectionCheckItem[] = [];
  for (const item of pending) {
    const hit = cache().get(keyOf(item));
    if (hit) {
      state.outcomes.set(item.key, { kind: 'verdict', flagged: hit.flagged });
      state.counts.cache_hit += 1;
      state.counts.checked += 1;
    } else {
      state.counts.cache_miss += 1;
      misses.push(item);
    }
  }
  return misses;
}

function markUnavailable(state: DetectorState, items: readonly InjectionCheckItem[], reason: string): void {
  for (const item of items) {
    if (state.outcomes.has(item.key)) continue;
    state.outcomes.set(item.key, { kind: 'unavailable', reason });
    state.counts.unavailable += 1;
  }
  if (items.length > 0 && state.unavailableReason === null) state.unavailableReason = reason;
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

/** Calls Prompt Guard for the items in groups of max_items; caches every verdict. Never throws. */
async function classifyPromptGuard(
  items: readonly InjectionCheckItem[],
  classifier: PromptGuardClassifier,
  scope: TenantScope,
  opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ verdicts: Map<string, boolean>; failure: string | null }> {
  const config = loadInjectionDetectorConfig().prompt_guard;
  const version = promptGuardVersion();
  const verdicts = new Map<string, boolean>();
  for (const group of chunked(items, config.max_items)) {
    let outcome: PromptGuardOutcome;
    try {
      outcome = await classifier(
        group.map((item, index) => ({ id: `i${index}`, text: item.text })),
        opts,
      );
    } catch {
      outcome = { ok: false, reason: 'unreachable' };
    }
    if (!outcome.ok) return { verdicts, failure: outcome.reason };
    group.forEach((item, index) => {
      const result = outcome.ok ? outcome.results[index] : undefined;
      if (!result) return;
      const flagged = result.score >= config.threshold;
      verdicts.set(item.key, flagged);
      cache().set(verdictCacheKey(scope, 'prompt_guard', version, item.text), { flagged, score: result.score, at: Date.now() });
    });
  }
  return { verdicts, failure: null };
}

/** At most one warm batch per process; a request never waits for it. Returns false when the batch was dropped. */
function scheduleWarm(items: readonly InjectionCheckItem[], classifier: PromptGuardClassifier, scope: TenantScope): boolean {
  if (items.length === 0) return true;
  if (warmInFlight) return false;
  const batch = items.map((item) => ({ ...item }));
  const job = classifyPromptGuard(batch, classifier, scope, { timeoutMs: PROMPT_GUARD_WARM_TIMEOUT_MS })
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (warmInFlight === job) warmInFlight = null;
    });
  warmInFlight = job;
  return true;
}

async function runPromptGuard(
  state: DetectorState,
  unflagged: readonly InjectionCheckItem[],
  input: ScopedInput,
  profile: DetectorProfile,
  inner: AbortSignal,
  innerMs: number,
): Promise<void> {
  const config = loadInjectionDetectorConfig().prompt_guard;
  const inline = config.inline_profiles.includes(profile);
  const warm = config.warm_profiles.includes(profile);
  if (!inline && !warm) {
    state.disabledReason = 'profile_disabled';
    return;
  }
  const languages = config.languages as readonly string[];
  const supported: InjectionCheckItem[] = [];
  for (const item of unflagged) {
    const language = detectLanguage(item.text);
    if (language !== null && languages.includes(language)) supported.push(item);
    else state.counts.unsupported_language += 1;
  }
  const version = promptGuardVersion();
  const misses = lookup(state, supported, (item) => verdictCacheKey(input.scope, 'prompt_guard', version, item.text));
  if (misses.length === 0) return;

  if (!inline) {
    if (!scheduleWarm(misses, input.promptGuardClassifier, input.scope)) state.warmDropped += 1;
    return;
  }
  state.inFlight = misses;
  const result = await classifyPromptGuard(misses, input.promptGuardClassifier, input.scope, { signal: inner, timeoutMs: innerMs });
  for (const [key, flagged] of result.verdicts) {
    state.outcomes.set(key, { kind: 'verdict', flagged });
    state.counts.checked += 1;
  }
  if (result.failure === 'not_configured') {
    state.disabledReason = 'not_configured';
    return;
  }
  if (result.failure !== null) {
    const reason = result.failure === 'aborted' && !input.signal.aborted ? 'timeout' : result.failure;
    markUnavailable(state, misses, reason);
  }
}

async function runLakera(
  state: DetectorState,
  unflagged: readonly InjectionCheckItem[],
  input: ScopedInput,
  profile: DetectorProfile,
  inner: AbortSignal,
): Promise<void> {
  if (!loadInjectionDetectorConfig().lakera.profiles.includes(profile)) {
    state.disabledReason = 'profile_disabled';
    return;
  }
  const detector = input.lakeraDetector();
  const misses = lookup(state, unflagged, (item) => verdictCacheKey(input.scope, 'lakera', detector.version, item.text));
  if (misses.length === 0) return;
  state.inFlight = misses;
  let outcomes: Awaited<ReturnType<typeof detector.classify>>;
  try {
    outcomes = await detector.classify(
      misses.map((item) => item.text),
      { signal: inner, profile, traceId: input.traceId, scope: input.scope },
    );
  } catch {
    outcomes = misses.map(() => ({ kind: 'unavailable', reason: 'network' }));
  }
  const failed: InjectionCheckItem[] = [];
  let failure: string | null = null;
  misses.forEach((item, index) => {
    const outcome = outcomes[index];
    if (outcome?.kind === 'verdict') {
      state.outcomes.set(item.key, { kind: 'verdict', flagged: outcome.verdict.flagged });
      state.counts.checked += 1;
      cache().set(verdictCacheKey(input.scope, 'lakera', detector.version, item.text), outcome.verdict);
      return;
    }
    failed.push(item);
    const reason = outcome?.reason ?? 'network';
    failure ??= reason === 'aborted' && !input.signal.aborted ? 'timeout' : reason;
  });
  if (failed.length > 0) markUnavailable(state, failed, failure ?? 'network');
}

/**
 * The gate for each ML detector and the parallel fan-out. Voice and media never reach a detector; the Lakera gate is
 * lakeraAllowed with the real deployment mode, evaluated before any Lakera call is built.
 */
export async function runInjectionDetectors(input: InjectionDetectorsInput): Promise<InjectionDetectorsRun> {
  const none: InjectionDetectorsRun = { verdicts: input.verdicts, reported: [], counts: {}, unavailable: [], disabled: {}, failures: {} };
  const { security, profile } = input;
  if (security.injectionCheck === 'off' || !isMlProfile(profile) || input.scope === null) return none;
  const scoped: ScopedInput = { ...input, scope: input.scope };

  const states = new Map<MlDetectorId, DetectorState>();
  if (security.promptGuard) states.set('prompt_guard', newState());
  if (security.lakera || security.lakeraMultiTenantAck) {
    const state = newState();
    const gate = lakeraAllowed({
      injectionCheck: security.injectionCheck,
      lakera: security.lakera,
      multiTenant: (input.multiTenant ?? isMultiTenant)(),
      ack: security.lakeraMultiTenantAck,
      apiKeyPresent: (security.lakeraApiKey?.trim() ?? '') !== '',
    });
    if (!gate.allowed) state.disabledReason = gate.reason;
    states.set('lakera', state);
  }
  if (states.size === 0) return none;

  const unflagged = input.items.filter((item) => input.verdicts.get(item.key)?.flagged !== true);
  const reserve = loadInjectionDetectorConfig().inner_reserve_ms;
  const innerMs = Math.max(1, input.budgetMs - reserve);
  const inner = AbortSignal.any([input.signal, AbortSignal.timeout(innerMs)]);

  const runs: Array<{ id: MlDetectorId; items: readonly InjectionCheckItem[]; run: Promise<void> }> = [];
  const promptGuard = states.get('prompt_guard');
  if (promptGuard && unflagged.length > 0) {
    runs.push({ id: 'prompt_guard', items: unflagged, run: runPromptGuard(promptGuard, unflagged, scoped, profile, inner, innerMs) });
  }
  const lakera = states.get('lakera');
  if (lakera && lakera.disabledReason === null && unflagged.length > 0) {
    runs.push({ id: 'lakera', items: unflagged, run: runLakera(lakera, unflagged, scoped, profile, inner) });
  }
  if (runs.length > 0) {
    const settled = await Promise.race([Promise.all(runs.map((entry) => entry.run.catch(() => undefined))), abortPromise(inner)]);
    if (settled === 'aborted') {
      const reason = input.signal.aborted ? 'aborted' : 'timeout';
      for (const state of states.values()) markUnavailable(state, state.inFlight, reason);
    }
  }

  const merged = new Map<string, InjectionVerdict>(input.verdicts);
  const flaggedBy = new Map<MlDetectorId, number>();
  for (const item of unflagged) {
    const sources: MlDetectorId[] = [];
    for (const [id, state] of states) {
      const outcome = state.outcomes.get(item.key);
      if (outcome?.kind === 'verdict' && outcome.flagged) sources.push(id);
    }
    if (sources.length === 0) continue;
    for (const id of sources) flaggedBy.set(id, (flaggedBy.get(id) ?? 0) + 1);
    const base = input.verdicts.get(item.key);
    merged.set(item.key, { flagged: true, ruleIds: base?.ruleIds ?? [], error: base?.error ?? false, sources });
  }

  const counts: Record<string, number> = {};
  const unavailable: MlDetectorId[] = [];
  const disabled: Partial<Record<MlDetectorId, string>> = {};
  const failures: Partial<Record<MlDetectorId, string>> = {};
  const mode = security.injectionCheck;
  for (const [id, state] of states) {
    const flagged = flaggedBy.get(id) ?? 0;
    counts[`${id}_checked`] = state.counts.checked;
    counts[`${id}_flagged`] = flagged;
    counts[`${id}_dropped`] = mode === 'drop' ? flagged : 0;
    counts[`${id}_downweighted`] = mode === 'downweight' ? flagged : 0;
    counts[`${id}_unavailable`] = state.counts.unavailable;
    counts[`${id}_disabled`] = state.disabledReason === null ? 0 : 1;
    counts[`${id}_unsupported_language`] = state.counts.unsupported_language;
    counts[`${id}_cache_hit`] = state.counts.cache_hit;
    counts[`${id}_cache_miss`] = state.counts.cache_miss;
    if (id === 'prompt_guard') counts.prompt_guard_warm_dropped = state.warmDropped;
    if (state.disabledReason !== null) disabled[id] = state.disabledReason;
    if (state.counts.unavailable > 0) {
      unavailable.push(id);
      failures[id] = state.unavailableReason ?? 'unavailable';
    }
  }
  return { verdicts: merged, reported: [...states.keys()], counts, unavailable, disabled, failures };
}
