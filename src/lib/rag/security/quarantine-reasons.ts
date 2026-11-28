import { QuarantineReasonSchema, type QuarantineReason } from '@/lib/rag-eval/contracts.generated';
import type { ZeroWidthFinding } from './zero-width';

export type { QuarantineReason };
export type QuarantineReasonKind = QuarantineReason['kind'];

/** D-32: reasons are always stored and shown in this order, whichever check ran first. */
export const QUARANTINE_REASON_ORDER: readonly QuarantineReasonKind[] = ['injection_rule', 'hidden_text', 'untrusted_link', 'invoice_extraction'];

export const INJECTION_RULES_CHECKER_VERSION = 'injection-rules/1';
export const INVOICE_EXTRACTION_CHECKER_VERSION = 'invoice-extraction/1';
const MAX_DETAIL = 500;
const MAX_SNIPPETS = 3;

function detail(text: string): string {
  return text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL - 1)}…`;
}

/** One injection_rule reason naming the matched rule ids; null when no rule matched. Carries no document text. */
export function injectionRuleReason(ruleIds: readonly string[]): QuarantineReason | null {
  if (ruleIds.length === 0) return null;
  return {
    kind: 'injection_rule',
    detail: detail(`Matched injection rules: ${ruleIds.join(', ')}`),
    checker_version: INJECTION_RULES_CHECKER_VERSION,
    unlocated: 0,
  };
}

/** The hidden_text reason of the zero-width check: one span per code point, named `U+200B`, never the surrounding text. */
export function zeroWidthReason(finding: ZeroWidthFinding, threshold: number, rulesVersion: string): QuarantineReason | null {
  if (finding.total === 0) return null;
  return {
    kind: 'hidden_text',
    detail: detail(`${finding.total} zero-width characters (threshold ${threshold})`),
    spans: finding.byCodePoint.map((entry) => ({ page: null, text: entry.codePoint, reason: 'zero_width' as const })),
    checker_version: `zero-width/${rulesVersion}`,
    unlocated: 0,
  };
}

/** How an older quarantined row without reasons is presented: its rule ids as one injection_rule reason (or the invoice reason). */
export function legacyQuarantineReasons(ruleIds: readonly string[], detectedBy: 'injection_scan' | 'invoice_extraction'): QuarantineReason[] {
  const injection = injectionRuleReason(ruleIds);
  if (injection) return [injection];
  if (detectedBy === 'invoice_extraction') {
    return [{ kind: 'invoice_extraction', detail: 'Invoice extraction quarantined the document', checker_version: INVOICE_EXTRACTION_CHECKER_VERSION, unlocated: 0 }];
  }
  return [];
}

function rank(kind: QuarantineReasonKind): number {
  return QUARANTINE_REASON_ORDER.indexOf(kind);
}

/**
 * Validates candidate reasons with the generated schema and returns them in the fixed order; one reason per kind, the last one given
 * wins. Entries that fail validation are dropped and counted, never logged.
 */
export function buildQuarantineReasons(candidates: readonly unknown[]): { reasons: QuarantineReason[]; dropped: number } {
  const byKind = new Map<QuarantineReasonKind, QuarantineReason>();
  let dropped = 0;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const parsed = QuarantineReasonSchema.safeParse(candidate);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    byKind.set(parsed.data.kind, parsed.data);
  }
  const reasons = [...byKind.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
  return { reasons, dropped };
}

export interface QuarantineMetadataInput {
  reasons: readonly QuarantineReason[];
  ruleIds: readonly string[];
  snippets: readonly string[];
  /** D-36: the upload also needed approval; a release then counts as the approval. */
  approvalRequired?: boolean;
  quarantinedAt: string;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The metadata.quarantine object: rule_ids and snippets stay as before, reasons[] is added (D-32). An earlier quarantine object of the
 * same run is merged: rule ids are united, snippets kept up to three, reasons merged by kind, the first quarantined_at kept.
 */
export function mergeQuarantineMetadata(existing: unknown, input: QuarantineMetadataInput): Record<string, unknown> {
  const prior = existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  const ruleIds = [...new Set([...stringList(prior.rule_ids), ...input.ruleIds])];
  const snippets = [...stringList(prior.snippets), ...input.snippets].slice(0, MAX_SNIPPETS);
  const priorReasons = Array.isArray(prior.reasons) ? prior.reasons : [];
  const merged = buildQuarantineReasons([...priorReasons, ...input.reasons]).reasons;
  const united = injectionRuleReason(ruleIds);
  const reasons = merged.map((reason) => (reason.kind === 'injection_rule' && united ? united : reason));
  const quarantinedAt = typeof prior.quarantined_at === 'string' && prior.quarantined_at !== '' ? prior.quarantined_at : input.quarantinedAt;
  return {
    ...prior,
    rule_ids: ruleIds,
    snippets,
    reasons,
    quarantined_at: quarantinedAt,
    ...(input.approvalRequired === true || prior.approval_required === true ? { approval_required: true } : {}),
  };
}
