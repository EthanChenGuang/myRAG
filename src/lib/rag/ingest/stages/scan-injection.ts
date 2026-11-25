import { HiddenTextReportSchema } from '@/lib/rag-eval/contracts.generated';
import { scanText, type InjectionScanResult } from '../../security/injection-scan';
import {
  injectionRuleReason,
  mergeQuarantineMetadata,
  zeroWidthReason,
  type QuarantineReason,
} from '../../security/quarantine-reasons';
import { findZeroWidth, loadHiddenTextRules, stripZeroWidth } from '../../security/zero-width';
import type { IngestConfig } from '../config';
import { requireDocument, requireIdentity, type StageContext, type StageName, type StageOutcome, type StageSpec } from '../types';

export interface QuarantineFindings {
  reasons: readonly QuarantineReason[];
  ruleIds: readonly string[];
  snippets: readonly string[];
  /** Written as documents.hidden_text_check when a hidden-text reason quarantined the document. */
  hiddenTextCheck?: 'hidden_found';
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

export type ScanCheckResult =
  | {
      outcome: string;
      reasons?: QuarantineReason[];
      injection?: InjectionScanResult;
      /** Top-level metadata keys recorded without quarantining (flag mode). */
      metadata?: Record<string, unknown>;
      hiddenTextCheck?: 'hidden_found';
    }
  | { fail: string };

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

function stripParseOutput(ctx: StageContext): void {
  if (typeof ctx.work.parseText === 'string') ctx.work.parseText = stripZeroWidth(ctx.work.parseText);
  if (Array.isArray(ctx.work.parseChunks)) {
    ctx.work.parseChunks = ctx.work.parseChunks.map((chunk) => ({
      ...chunk,
      text: stripZeroWidth(chunk.text),
      contextualized_text: stripZeroWidth(chunk.contextualized_text),
      headings: chunk.headings.map(stripZeroWidth),
      table_header: typeof chunk.table_header === 'string' ? stripZeroWidth(chunk.table_header) : chunk.table_header,
    }));
  }
}

/**
 * D-34 removal on a resumed run: the stored parse text still holds the characters, so a run past scan_injection under quarantine strips
 * them again before chunking. Deterministic, no report, no log.
 */
export function reapplyHiddenTextRemoval(ctx: StageContext): void {
  if (ctx.config.hiddenTextCheck === 'quarantine') stripParseOutput(ctx);
}

/**
 * Hidden text (RAG_HIDDEN_TEXT_CHECK, D-33, D-34): zero-width characters on every parse text, checked here in TypeScript; the sidecar
 * report over the stored original joins this check in plan 37. flag records the report and changes nothing else. quarantine strips the
 * characters from the parse text and the parser's chunks before chunking; at or above the threshold the document is quarantined.
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
    const finding = findZeroWidth(ctx.work.parseText ?? '');
    const checkerVersion = `zero-width/${rules.rules_version}`;

    if (mode === 'flag') {
      const report = HiddenTextReportSchema.parse({
        status: finding.total > 0 ? 'hidden_found' : 'clean',
        spans: finding.byCodePoint.map((entry) => ({ page: null, text: entry.codePoint, reason: 'zero_width', bbox: null })),
        link_targets: [],
        checker_version: checkerVersion,
        dropped: 0,
      });
      return { outcome: finding.total > 0 ? 'flagged' : 'clean', metadata: { hidden_text_report: report } };
    }

    if (finding.total === 0) return { outcome: 'clean' };
    stripParseOutput(ctx);
    if (finding.total < rules.zero_width_threshold) {
      console.warn('[RAG Security] zero-width characters stripped below the quarantine threshold', { count: finding.total });
      return { outcome: 'zero_width_stripped' };
    }
    const reason = zeroWidthReason(finding, rules.zero_width_threshold, rules.rules_version);
    return { outcome: 'quarantined', reasons: reason ? [reason] : [], hiddenTextCheck: 'hidden_found' };
  },
};

/** The checks of the stage in run order. The link check (D-35) is registered here by plan 39. */
export const SCAN_CHECKS: readonly ScanCheck[] = [injectionRulesCheck, hiddenTextCheck];

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
  let hiddenTextFound = false;
  for (const check of enabled) {
    const result = await check.run(ctx);
    if ('fail' in result) return { kind: 'fail', reason: result.fail };
    outcomes.push(`${check.name}:${result.outcome}`);
    if (result.injection) injection = result.injection;
    if (result.hiddenTextCheck) hiddenTextFound = true;
    if (result.reasons) reasons.push(...result.reasons);
    if (result.metadata) Object.assign(recorded, result.metadata);
  }

  const quarantined = reasons.length > 0 || injection !== null;
  const legacy = !newChecksOn(ctx.config);
  const document = Object.keys(recorded).length > 0 || quarantined ? requireDocument(ctx, 'scan_injection') : null;
  if (document && Object.keys(recorded).length > 0) await ctx.writer.setFields(document.id, { metadata: recorded });
  if (quarantined) {
    await writeQuarantine(
      ctx,
      'scan_injection',
      {
        reasons,
        ruleIds: injection?.rule_ids ?? [],
        snippets: injection?.snippets ?? [],
        ...(hiddenTextFound ? { hiddenTextCheck: 'hidden_found' as const } : {}),
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
