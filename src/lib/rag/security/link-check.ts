import { LinkCheckResultSchema, type LinkCheckResult } from '@/lib/rag-eval/contracts.generated';
import { extractLinkCandidates, type LinkExtractionRules } from '@/lib/url-extractor';
import rawRules from '../../../../config/rag/link-rules.json';
import { isAllowedHost, normalizeHost } from './link-allowlist';

/**
 * The ingestion link check (D-35, SEC-08): every URL, bare domain and e-mail address of the parse text, plus the PDF link annotation
 * targets of the hidden-text report, checked against the allowlist. Pure: no target is fetched, resolved or opened.
 */

export interface LinkRules extends LinkExtractionRules {
  schema_version: 1;
  rules_version: string;
  max_targets: number;
}

export type LinkTargetKind = 'url' | 'domain' | 'email' | 'annotation';
export type LinkTarget = NonNullable<LinkCheckResult['targets']>[number];

/** The result plus how many targets beyond max_targets were left out of it. */
export type LinkCheckOutcome = LinkCheckResult & { dropped: number };

export interface CheckLinksOptions {
  allowlist: ReadonlySet<string>;
  /** PDF link annotation targets (HiddenTextReport.link_targets); absent when no report was made. */
  annotationTargets?: readonly string[];
  /** Targets an admin reviewed when releasing an earlier version of the same lineage; skipped. */
  releasedTargets?: readonly string[];
  rules?: LinkRules;
}

const KIND_ORDER: readonly LinkTargetKind[] = ['url', 'domain', 'email', 'annotation'];
const MAX_TARGET = 2048;
const MAX_HOST = 253;

function validRules(value: unknown): LinkRules {
  const rules = value as Partial<LinkRules> | null;
  const strings = (list: unknown) => Array.isArray(list) && list.every((entry) => typeof entry === 'string');
  if (
    !rules ||
    rules.schema_version !== 1 ||
    typeof rules.rules_version !== 'string' ||
    !strings(rules.url_schemes) ||
    !strings(rules.bare_host_last_labels) ||
    !strings(rules.never_domain_extensions) ||
    typeof rules.www_prefix !== 'boolean' ||
    typeof rules.bare_host_lowercase_last_label !== 'boolean' ||
    !Number.isInteger(rules.max_targets) ||
    (rules.max_targets ?? 0) < 1 ||
    (rules.max_targets ?? 0) > 200
  ) {
    throw new Error('link_rules_invalid');
  }
  return rules as LinkRules;
}

let override: LinkRules | null = null;

/** config/rag/link-rules.json, validated; throws when it is invalid. */
export function loadLinkRules(): LinkRules {
  return override ?? validRules(rawRules);
}

export function setLinkRulesForTests(rules: unknown): void {
  override = validRules(rules);
}

export function resetLinkRulesForTests(): void {
  override = null;
}

export function linkCheckerVersion(rules: LinkRules): string {
  return `link-check/${rules.rules_version}`;
}

interface Normalized {
  kind: LinkTargetKind;
  target: string;
  host: string;
}

/** A URL (or annotation) with a host: its href with the normalized host. Anything without a host is not a link target. */
function normalizeUrl(kind: 'url' | 'annotation', value: string): Normalized | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol === 'mailto:') {
    const address = decodeURIComponent(url.pathname).split('?')[0] ?? '';
    const email = normalizeEmail(address);
    return email ? { ...email, kind } : null;
  }
  const host = normalizeHost(url.hostname);
  if (host === null) return null;
  url.hostname = host;
  return { kind, target: url.href, host };
}

function normalizeEmail(value: string): Normalized | null {
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const host = normalizeHost(value.slice(at + 1));
  if (host === null) return null;
  return { kind: 'email', target: `${value.slice(0, at).toLowerCase()}@${host}`, host };
}

function normalizeCandidate(kind: 'url' | 'domain' | 'email', value: string): Normalized | null {
  if (kind === 'url') return normalizeUrl('url', value);
  if (kind === 'email') return normalizeEmail(value);
  const host = normalizeHost(value);
  return host === null ? null : { kind: 'domain', target: host, host };
}

function compare(a: Normalized, b: Normalized): number {
  const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (byKind !== 0) return byKind;
  return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
}

/**
 * The targets outside the allowlist, de-duplicated and sorted by kind and then normalized target, so the result is the same on every
 * run; at most max_targets are kept and the rest counted in dropped. A target an admin released on an earlier version is skipped.
 */
export function checkLinks(text: string, options: CheckLinksOptions): LinkCheckOutcome {
  const rules = options.rules ?? loadLinkRules();
  const released = new Set(options.releasedTargets ?? []);
  const seen = new Map<string, Normalized>();
  const consider = (candidate: Normalized | null) => {
    if (candidate === null) return;
    if (isAllowedHost(candidate.host, options.allowlist)) return;
    if (released.has(candidate.target)) return;
    const key = `${candidate.kind}\u0000${candidate.target}`;
    if (!seen.has(key)) seen.set(key, candidate);
  };
  for (const candidate of extractLinkCandidates(text, rules)) consider(normalizeCandidate(candidate.kind, candidate.value));
  for (const target of options.annotationTargets ?? []) consider(normalizeUrl('annotation', target));

  const sorted = [...seen.values()].sort(compare);
  const kept = sorted.slice(0, rules.max_targets);
  const targets: LinkTarget[] = kept.map((entry) => ({
    kind: entry.kind,
    target: entry.target.slice(0, MAX_TARGET),
    host: entry.host.slice(0, MAX_HOST),
  }));
  const result = LinkCheckResultSchema.parse({
    status: targets.length > 0 ? 'untrusted_found' : 'clean',
    targets,
    checker_version: linkCheckerVersion(rules),
  });
  return { ...result, dropped: sorted.length - kept.length };
}
