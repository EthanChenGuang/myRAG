import { HiddenTextReportSchema, type HiddenTextReport } from '@/lib/rag-eval/contracts.generated';
import { hiddenTextMimeType, removeHiddenSpans, requestHiddenTextReport, type HiddenTextSpan, type SpanRemoval } from '../../security/hidden-text';
import { scanText, type InjectionScanResult } from '../../security/injection-scan';
import { parseLinkAllowlist } from '../../security/link-allowlist';
import { checkLinks, loadLinkRules, type LinkCheckOutcome, type LinkRules } from '../../security/link-check';
import {
  injectionRuleReason,
  mergeQuarantineMetadata,
  zeroWidthReason,
  type QuarantineReason,
} from '../../security/quarantine-reasons';
import { findZeroWidth, loadHiddenTextRules, stripZeroWidth, type ZeroWidthFinding } from '../../security/zero-width';
import { HIDDEN_TEXT_SANITIZED_KEY, PARSE_ARTIFACT, isArtifactName, loadArtifact, originalName, rewriteSanitizedArtifacts, versionPrefix } from '../artifacts';
import type { IngestConfig } from '../config';
import { saveContextState } from '../state-store';
import {
  IngestStageError,
  requireDocument,
  requireIdentity,
  type HiddenTextState,
  type StageContext,
  type StageName,
  type StageOutcome,
  type StageSpec,
} from '../types';

export interface QuarantineFindings {
  reasons: readonly QuarantineReason[];
  ruleIds: readonly string[];
  snippets: readonly string[];
  /** Written as documents.hidden_text_check with the quarantine. */
  hiddenTextCheck?: HiddenTextCheckValue;
}

/**
 * Sets the document to quarantined with the merged reasons, the rule ids and up to three snippets of an injection match. Only rule ids,
 * reason kinds and counts are logged. Called before any chunk is written, so the chunk writer stamps every chunk quarantined and the
 * version is never published. With legacy set (both new checks off) metadata.quarantine keeps today's exact shape.
 */
async function writeQuarantine(ctx: StageContext, stage: StageName, findings: QuarantineFindings, legacy: boolean): Promise<void> {
  const document = requireDocument(ctx, stage);
  const quarantinedAt = new Date().toISOString();
  const quarantine = legacy
    ? { rule_ids: [...findings.ruleIds], snippets: [...findings.snippets], quarantined_at: quarantinedAt }
    : mergeQuarantineMetadata(null, {
        reasons: findings.reasons,
        ruleIds: findings.ruleIds,
        snippets: findings.snippets,
        approvalRequired: ctx.state.approval?.required === true,
        quarantinedAt,
      });
  await ctx.writer.setFields(document.id, {
    status: 'quarantined',
    ...(findings.hiddenTextCheck ? { hidden_text_check: findings.hiddenTextCheck } : {}),
    metadata: { quarantine },
  });
  ctx.state.quarantine = { ruleIds: [...findings.ruleIds], released: false };
  if (findings.ruleIds.length > 0) console.warn('[Ingest] injection scan quarantined a document', { ruleIds: findings.ruleIds });
  if (!legacy) console.warn('[RAG Security] document quarantined', { reasons: findings.reasons.map((reason) => reason.kind) });
}

/** The injection-rule quarantine of a caption or another later stage: today's metadata shape plus, with a new check on, the reason. */
export async function quarantineDocument(ctx: StageContext, stage: StageName, result: InjectionScanResult): Promise<void> {
  const reason = injectionRuleReason(result.rule_ids);
  const legacy = !newChecksOn(ctx.config);
  await writeQuarantine(ctx, stage, { reasons: reason ? [reason] : [], ruleIds: result.rule_ids, snippets: result.snippets }, legacy);
}

function newChecksOn(config: IngestConfig): boolean {
  return config.hiddenTextCheck !== 'off' || config.ingestLinkCheck !== 'off';
}

export type ScanCheckName = 'injection_rules' | 'hidden_text' | 'links';
export type HiddenTextCheckValue = 'clean' | 'hidden_found' | 'not_checked';

export type ScanCheckResult =
  | {
      outcome: string;
      reasons?: QuarantineReason[];
      injection?: InjectionScanResult;
      /** Top-level metadata keys recorded on the document (the flag report, the sanitized marker). */
      metadata?: Record<string, unknown>;
      /** documents.hidden_text_check of the version (D-34). */
      hiddenTextCheck?: HiddenTextCheckValue;
    }
  | { fail: string }
  | { yield: string };

export interface ScanCheck {
  name: ScanCheckName;
  enabled(config: IngestConfig): boolean;
  run(ctx: StageContext): Promise<ScanCheckResult>;
}

/** Injection rules (RAG_INJECTION_SCAN, unchanged). Fails closed when the rules cannot be loaded. */
const injectionRulesCheck: ScanCheck = {
  name: 'injection_rules',
  enabled: (config) => config.injectionScan !== 'off',
  async run(ctx) {
    let result: InjectionScanResult;
    try {
      result = scanText(ctx.work.parseText ?? '');
    } catch (error) {
      console.error('[Ingest] injection scan unavailable', { reason: error instanceof Error ? error.message : 'unknown' });
      return { fail: 'injection_scan_unavailable' };
    }
    if (!result.matched) return { outcome: 'scan_clean' };
    const reason = injectionRuleReason(result.rule_ids);
    return { outcome: 'quarantined', reasons: reason ? [reason] : [], injection: result };
  },
};

type TextMap = (text: string) => string;

/** Applies one text transformation to every text field of the parser's chunks. */
function mapParseChunks(ctx: StageContext, map: TextMap): void {
  if (Array.isArray(ctx.work.parseChunks)) {
    ctx.work.parseChunks = ctx.work.parseChunks.map((chunk) => ({
      ...chunk,
      text: map(chunk.text),
      contextualized_text: map(chunk.contextualized_text),
      headings: chunk.headings.map(map),
      table_header: typeof chunk.table_header === 'string' ? map(chunk.table_header) : chunk.table_header,
    }));
  }
}

function stripParseOutput(ctx: StageContext): void {
  if (typeof ctx.work.parseText === 'string') ctx.work.parseText = stripZeroWidth(ctx.work.parseText);
  mapParseChunks(ctx, stripZeroWidth);
}

/** Removes the spans from the parse text (the located and unlocated lists come from it) and from the parser's chunks. */
function removeSpansFromParseOutput(ctx: StageContext, spans: readonly string[]): SpanRemoval {
  const removal = removeHiddenSpans(ctx.work.parseText ?? '', spans);
  if (typeof ctx.work.parseText === 'string') ctx.work.parseText = removal.text;
  mapParseChunks(ctx, (text) => removeHiddenSpans(text, spans).text);
  return removal;
}

/**
 * D-34 removal on a resumed run: the stored parse text may still hold zero-width characters (and, after a crash before the artifacts were
 * rewritten, hidden spans), so a run past scan_injection under quarantine removes them again before chunking. Deterministic, no report,
 * no log; removing an already removed span changes nothing.
 */
export function reapplyHiddenTextRemoval(ctx: StageContext): void {
  if (ctx.config.hiddenTextCheck !== 'quarantine') return;
  stripParseOutput(ctx);
  const spans = ctx.state.hiddenText?.removedSpans ?? [];
  if (spans.length > 0) removeSpansFromParseOutput(ctx, spans);
}

/** The spans the write-time assertion checks: those removed under quarantine, none otherwise. */
export function removedHiddenSpans(ctx: Pick<StageContext, 'state'>): string[] {
  return ctx.state.hiddenText?.removedSpans ?? [];
}

/** Less than this left before the deadline: the run yields instead of calling the checker. */
const MIN_CHECK_MS = 5000;
/** Upper bound of one checker call; the sidecar stops its own check at 60 s. */
const MAX_CHECK_MS = 65_000;
const MAX_REPORT_SPANS = 200;

type OriginalForCheck = { kind: 'unsupported' } | { kind: 'missing' } | { kind: 'file'; bytes: Uint8Array; mimeType: string };

/**
 * The stored original of a file the sidecar can check: the upload's bytes, or on a resumed run (no upload) the stored original object.
 * Text input and formats without a checker are unsupported.
 */
async function originalForCheck(ctx: StageContext): Promise<OriginalForCheck> {
  if (ctx.input.text !== undefined) return { kind: 'unsupported' };
  const identity = requireIdentity(ctx, 'scan_injection');
  const document = requireDocument(ctx, 'scan_injection');
  if (identity.bytes && identity.bytes.byteLength > 0) {
    const mimeType = hiddenTextMimeType(ctx.input.mimeType, identity.filename);
    return mimeType === null ? { kind: 'unsupported' } : { kind: 'file', bytes: identity.bytes, mimeType };
  }
  // A resumed run carries no upload; a known media type that has no checker needs no read.
  if (ctx.input.mimeType !== '' && hiddenTextMimeType(ctx.input.mimeType, identity.filename) === null) return { kind: 'unsupported' };
  const prefix = versionPrefix(identity.tenantKey, document.lineageId, document.version);
  const path = document.originalPath ?? null;
  const name = path === null ? originalName(identity.filename) : path.startsWith(prefix) ? path.slice(prefix.length) : '';
  if (!isArtifactName(name)) return { kind: 'missing' };
  const stored = await loadArtifact(ctx, name);
  if (!stored) return { kind: 'missing' };
  const mimeType = hiddenTextMimeType(stored.contentType || ctx.input.mimeType, identity.filename);
  return mimeType === null ? { kind: 'unsupported' } : { kind: 'file', bytes: stored.bytes, mimeType };
}

type SidecarResult = { kind: 'report'; report: HiddenTextReport } | { kind: 'not_checked'; failure: string | null } | { kind: 'yield' };

/** The sidecar report of this version: reused from the state of an earlier attempt for the same original, or requested now. */
async function sidecarReport(ctx: StageContext): Promise<SidecarResult> {
  const identity = requireIdentity(ctx, 'scan_injection');
  const saved = ctx.state.hiddenText;
  if (saved && saved.fileSha256 === identity.fileSha256) return saved.report ? { kind: 'report', report: saved.report } : { kind: 'not_checked', failure: null };
  const original = await originalForCheck(ctx);
  if (original.kind === 'unsupported') return { kind: 'not_checked', failure: null };
  if (original.kind === 'missing') return { kind: 'not_checked', failure: 'original_unavailable' };
  const remaining = ctx.deadline - ctx.deps.now();
  if (remaining < MIN_CHECK_MS) return { kind: 'yield' };
  const outcome = await requestHiddenTextReport(
    { bytes: original.bytes, mimeType: original.mimeType, filename: identity.filename },
    { signal: ctx.signal, timeoutMs: Math.min(MAX_CHECK_MS, remaining - 2000) },
  );
  ctx.signal.throwIfAborted();
  if (!outcome.ok) return { kind: 'not_checked', failure: outcome.error ?? outcome.reason };
  return { kind: 'report', report: outcome.report };
}

function zeroWidthSpans(finding: ZeroWidthFinding): HiddenTextSpan[] {
  return finding.byCodePoint.map((entry) => ({ page: null, text: entry.codePoint, reason: 'zero_width' as const, bbox: null }));
}

/** The report recorded under flag: the sidecar's spans, then the zero-width ones; status hidden_found, clean only when the sidecar checked it, else not_checked. */
function mergedReport(report: HiddenTextReport | null, finding: ZeroWidthFinding, rulesVersion: string): HiddenTextReport {
  const spans = [...(report?.status === 'hidden_found' ? (report.spans ?? []) : []), ...zeroWidthSpans(finding)];
  const status = spans.length > 0 ? 'hidden_found' : report?.status === 'clean' ? 'clean' : 'not_checked';
  return HiddenTextReportSchema.parse({
    status,
    spans: spans.slice(0, MAX_REPORT_SPANS),
    link_targets: report?.link_targets ?? [],
    checker_version: report?.checker_version ?? `zero-width/${rulesVersion}`,
    dropped: (report?.dropped ?? 0) + Math.max(0, spans.length - MAX_REPORT_SPANS),
  });
}

/** One hidden_text reason for the sidecar spans and the zero-width finding together; at most 200 spans, the rest counted as unlocated. */
function hiddenTextReason(
  report: HiddenTextReport | null,
  finding: ZeroWidthFinding,
  zeroWidthQuarantines: boolean,
  unlocated: number,
  rules: ReturnType<typeof loadHiddenTextRules>,
): QuarantineReason | null {
  const sidecarSpans = report?.status === 'hidden_found' ? (report.spans ?? []) : [];
  if (sidecarSpans.length === 0) {
    if (!zeroWidthQuarantines) return null;
    const reason = zeroWidthReason(finding, rules.zero_width_threshold, rules.rules_version);
    return reason && unlocated > 0 ? { ...reason, unlocated } : reason;
  }
  const spans = [...sidecarSpans.map((span) => ({ page: span.page, text: span.text, reason: span.reason })), ...(zeroWidthQuarantines ? zeroWidthSpans(finding).map(({ bbox: _bbox, ...span }) => span) : [])];
  const kinds = [...new Set(sidecarSpans.map((span) => span.reason))].join(', ');
  const parts = [`${sidecarSpans.length} hidden spans (${kinds})`];
  if (zeroWidthQuarantines) parts.push(`${finding.total} zero-width characters (threshold ${rules.zero_width_threshold})`);
  if (unlocated > 0) parts.push(`${unlocated} not located in the parsed text`);
  const detail = parts.join('; ');
  return {
    kind: 'hidden_text',
    detail: detail.length <= 500 ? detail : `${detail.slice(0, 499)}…`,
    spans: spans.slice(0, MAX_REPORT_SPANS),
    checker_version: report?.checker_version ?? `zero-width/${rules.rules_version}`,
    unlocated: unlocated + Math.max(0, spans.length - MAX_REPORT_SPANS),
  };
}

/**
 * Overwrites parse.md and chunks.json with the sanitized parse output (F-17) once the state that makes a retry idempotent is saved. Only a
 * run that stored its parse output has anything to rewrite.
 */
async function persistSanitized(ctx: StageContext, state: HiddenTextState): Promise<boolean> {
  if (ctx.state.artifacts[PARSE_ARTIFACT] === undefined) return false;
  ctx.state.hiddenText = { ...state, sanitized: true };
  await saveContextState(ctx, 'processing');
  try {
    await rewriteSanitizedArtifacts(ctx, { parseText: ctx.work.parseText ?? '', parseChunks: ctx.work.parseChunks });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw new IngestStageError('scan_injection', 'store_sanitized_output_failed');
  }
  return true;
}

/**
 * Hidden text (RAG_HIDDEN_TEXT_CHECK, D-33, D-34). Zero-width characters are counted on every parse text here in TypeScript; PDF and Word
 * originals are also sent to the sidecar's checker, whose report is reused from the state on a retry. flag records the merged report and
 * documents.hidden_text_check and changes nothing else. quarantine strips the zero-width characters and removes the hidden spans from the
 * parse text and the parser's chunks before chunking, rewrites the stored parse output, and quarantines the document with the spans as the
 * reason; a checker that cannot answer fails the run closed. A format without a checker is not_checked, never clean.
 */
const hiddenTextCheck: ScanCheck = {
  name: 'hidden_text',
  enabled: (config) => config.hiddenTextCheck !== 'off',
  async run(ctx) {
    const mode = ctx.config.hiddenTextCheck;
    let rules: ReturnType<typeof loadHiddenTextRules>;
    try {
      rules = loadHiddenTextRules();
    } catch {
      console.error('[RAG Security] hidden-text rules unavailable');
      return mode === 'quarantine' ? { fail: 'hidden_text_rules_unavailable' } : { outcome: 'rules_unavailable' };
    }
    const identity = requireIdentity(ctx, 'scan_injection');
    const finding = findZeroWidth(ctx.work.parseText ?? '');
    const sidecar = await sidecarReport(ctx);
    if (sidecar.kind === 'yield') return { yield: 'deadline' };
    if (sidecar.kind === 'not_checked' && sidecar.failure !== null) {
      console.warn('[RAG Security] hidden-text checker unavailable', { mode, failure: sidecar.failure });
      if (mode === 'quarantine') return { fail: 'hidden_text_checker_unavailable' };
      if (!ctx.warnings.includes('hidden_text_not_checked')) ctx.warnings.push('hidden_text_not_checked');
    }
    const report = sidecar.kind === 'report' ? sidecar.report : null;
    const saved = ctx.state.hiddenText?.fileSha256 === identity.fileSha256 ? ctx.state.hiddenText : undefined;

    if (mode === 'flag') {
      const merged = mergedReport(report, finding, rules.rules_version);
      ctx.state.hiddenText = { fileSha256: identity.fileSha256, report, removedSpans: [], unlocated: 0, sanitized: false };
      return {
        outcome: merged.status === 'hidden_found' ? 'flagged' : merged.status,
        metadata: { hidden_text_report: merged },
        hiddenTextCheck: merged.status,
      };
    }

    const sidecarSpans = report?.status === 'hidden_found' ? (report.spans ?? []).map((span) => span.text) : [];
    if (finding.total > 0) stripParseOutput(ctx);
    let unlocated = 0;
    if (sidecarSpans.length > 0) {
      const removal = removeSpansFromParseOutput(ctx, sidecarSpans);
      // A retry reads the sanitized text, where every span is gone: the count of the first removal stands. So does a type change that
      // reuses a sanitized parse output, whose spans were removed by the version before.
      unlocated = saved?.sanitized ? saved.unlocated : ctx.state.typeChange?.sanitizedParse ? 0 : removal.unlocated.length + (report?.dropped ?? 0);
    }
    const state: HiddenTextState = { fileSha256: identity.fileSha256, report, removedSpans: sidecarSpans, unlocated, sanitized: saved?.sanitized ?? false };
    ctx.state.hiddenText = state;
    const changed = finding.total > 0 || sidecarSpans.length > 0;
    const sanitized = changed ? await persistSanitized(ctx, state) : false;
    const marker = sanitized ? { [HIDDEN_TEXT_SANITIZED_KEY]: true } : undefined;

    const zeroWidthQuarantines = finding.total >= rules.zero_width_threshold;
    const reason = hiddenTextReason(report, finding, zeroWidthQuarantines, unlocated, rules);
    if (reason) {
      console.warn('[RAG Security] hidden text removed', { spans: sidecarSpans.length, zeroWidth: finding.total, unlocated });
      return { outcome: 'quarantined', reasons: [reason], hiddenTextCheck: 'hidden_found', ...(marker ? { metadata: marker } : {}) };
    }
    if (finding.total > 0) console.warn('[RAG Security] zero-width characters stripped below the quarantine threshold', { count: finding.total });
    const check = report?.status === 'clean' ? 'clean' : 'not_checked';
    return {
      outcome: finding.total > 0 ? 'zero_width_stripped' : check,
      hiddenTextCheck: check,
      ...(marker ? { metadata: marker } : {}),
    };
  },
};

/** One untrusted_link reason listing the targets outside the allowlist; the detail names the count per kind and any targets left out. */
function untrustedLinkReason(result: LinkCheckOutcome): QuarantineReason | null {
  const targets = result.targets ?? [];
  if (targets.length === 0) return null;
  const counts = new Map<string, number>();
  for (const target of targets) counts.set(target.kind, (counts.get(target.kind) ?? 0) + 1);
  const kinds = [...counts.entries()].map(([kind, count]) => `${kind}: ${count}`).join(', ');
  const more = result.dropped > 0 ? `; ${result.dropped} more not listed` : '';
  return {
    kind: 'untrusted_link',
    detail: `${targets.length + result.dropped} link targets outside the allowlist (${kinds})${more}`,
    targets: targets.map((target) => target.target),
    checker_version: result.checker_version,
    unlocated: 0,
  };
}

/** The targets reviewed when an earlier version of the lineage was released; a first version has none. A failed read skips nothing. */
async function releasedTargets(ctx: StageContext): Promise<string[]> {
  const document = requireDocument(ctx, 'scan_injection');
  if (document.version <= 1 || !ctx.writer.releasedLinkTargets) return [];
  try {
    return await ctx.writer.releasedLinkTargets(document.id);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    console.warn('[RAG Security] released link targets unavailable');
    return [];
  }
}

/**
 * Links (RAG_INGEST_LINK_CHECK, D-35). Every URL, bare domain and e-mail address of the parse text, plus the PDF link annotation targets
 * of this version's hidden-text report when that check made one, is checked against RAG_OUTPUT_LINK_ALLOWLIST and the app's own host.
 * flag records metadata.link_check; quarantine also quarantines the document with one untrusted_link reason. Targets an admin reviewed on
 * an earlier version of the lineage are skipped; the allowlist itself never changes. No target is fetched, resolved or opened.
 */
const linksCheck: ScanCheck = {
  name: 'links',
  enabled: (config) => config.ingestLinkCheck !== 'off',
  async run(ctx) {
    const mode = ctx.config.ingestLinkCheck;
    let rules: LinkRules;
    try {
      rules = loadLinkRules();
    } catch {
      console.error('[RAG Security] link rules unavailable');
      return mode === 'quarantine' ? { fail: 'link_rules_unavailable' } : { outcome: 'rules_unavailable' };
    }
    const identity = requireIdentity(ctx, 'scan_injection');
    const hiddenText = ctx.state.hiddenText;
    const annotationTargets = hiddenText && hiddenText.fileSha256 === identity.fileSha256 ? (hiddenText.report?.link_targets ?? []) : [];
    const released = await releasedTargets(ctx);
    const result = checkLinks(ctx.work.parseText ?? '', {
      allowlist: parseLinkAllowlist(ctx.config.outputLinkAllowlist, ctx.config.siteUrl),
      annotationTargets,
      releasedTargets: released,
      rules,
    });
    const found = result.targets?.length ?? 0;
    const metadata = { link_check: result };
    if (found === 0) return { outcome: 'clean', ...(mode === 'flag' ? { metadata } : {}) };
    console.warn('[RAG Security] link targets outside the allowlist', { mode, targets: found + result.dropped, released: released.length });
    if (mode === 'flag') return { outcome: 'flagged', metadata };
    const reason = untrustedLinkReason(result);
    return { outcome: 'quarantined', reasons: reason ? [reason] : [], metadata };
  },
};

/** The checks of the stage in run order (D-32): injection rules, hidden text, links. */
export const SCAN_CHECKS: readonly ScanCheck[] = [injectionRulesCheck, hiddenTextCheck, linksCheck];

/**
 * scan_injection runs independent checks, each with its own switch and outcome (D-32). A check that quarantines adds its reasons; the
 * stage writes one merged quarantine before any chunk exists, so the chunk writer stamps every chunk quarantined and the D-08 filter keeps
 * them out of every retrieval. A check that cannot run under quarantine fails the run closed: text is never published unscanned.
 * Ingestion stays rules-only: no model call.
 */
export async function runScanChecks(ctx: StageContext, checks: readonly ScanCheck[]): Promise<StageOutcome> {
  const enabled = checks.filter((check) => check.enabled(ctx.config));
  if (enabled.length === 0) return { kind: 'next', disabled: true, outcome: 'scan_off' };
  const identity = requireIdentity(ctx, 'scan_injection');
  if (!identity.profile.scan_injection) return { kind: 'next', disabled: true, outcome: 'scan_profile_off' };

  const outcomes: string[] = [];
  const reasons: QuarantineReason[] = [];
  const recorded: Record<string, unknown> = {};
  let injection: InjectionScanResult | null = null;
  let hiddenTextCheckValue: HiddenTextCheckValue | null = null;
  for (const check of enabled) {
    const result = await check.run(ctx);
    if ('fail' in result) return { kind: 'fail', reason: result.fail };
    if ('yield' in result) return { kind: 'yield', reason: result.yield };
    outcomes.push(`${check.name}:${result.outcome}`);
    if (result.injection) injection = result.injection;
    if (result.hiddenTextCheck) hiddenTextCheckValue = result.hiddenTextCheck;
    if (result.reasons) reasons.push(...result.reasons);
    if (result.metadata) Object.assign(recorded, result.metadata);
  }

  const quarantined = reasons.length > 0 || injection !== null;
  const legacy = !newChecksOn(ctx.config);
  const unquarantinedCheck = !quarantined && hiddenTextCheckValue !== null ? hiddenTextCheckValue : null;
  const fields = {
    ...(unquarantinedCheck !== null ? { hidden_text_check: unquarantinedCheck } : {}),
    ...(Object.keys(recorded).length > 0 ? { metadata: recorded } : {}),
  };
  const document = Object.keys(fields).length > 0 || quarantined ? requireDocument(ctx, 'scan_injection') : null;
  if (document && Object.keys(fields).length > 0) await ctx.writer.setFields(document.id, fields);
  if (quarantined) {
    await writeQuarantine(
      ctx,
      'scan_injection',
      {
        reasons,
        ruleIds: injection?.rule_ids ?? [],
        snippets: injection?.snippets ?? [],
        ...(hiddenTextCheckValue !== null ? { hiddenTextCheck: hiddenTextCheckValue } : {}),
      },
      legacy,
    );
  }

  // Only the injection check on (today's configuration): today's outcome names, unchanged.
  const outcome = enabled.length === 1 && enabled[0]?.name === 'injection_rules' ? (quarantined ? 'quarantined' : 'scan_clean') : outcomes.join(',');
  return { kind: 'next', outcome };
}

async function run(ctx: StageContext): Promise<StageOutcome> {
  return runScanChecks(ctx, SCAN_CHECKS);
}

export const scanInjectionStage: StageSpec = { name: 'scan_injection', minMsNeeded: 0, run };
