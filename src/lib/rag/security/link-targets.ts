import { domainToASCII } from 'node:url';

import { findCitationMarkers } from '@/lib/citations/marker-grammar';
import { OutputGuardRulesSchema, type OutputGuardRules } from '@/lib/rag-eval/contracts.generated';
import { isAllowedImageUrl, type ImageHostAllowlist } from '@/lib/safe-image-hosts';
import rawRules from '../../../../config/rag/output-guard-rules.json';
import tldSnapshot from '../../../../config/rag/tld-snapshot.json';
import { isAllowedHost, parseLinkAllowlist } from './link-allowlist';

/**
 * Link targets in model output (D-37): detection of URLs, bare domains, e-mail addresses, obfuscated and opaque
 * forms, host normalization and the four allow rules. Rule 1 goes through the Phase 3.2 parser in link-allowlist.ts.
 * Pure: no network call, no DNS lookup, no logging.
 */

export type CandidateKind = 'url' | 'bare_domain' | 'email' | 'obfuscated' | 'opaque_scheme' | 'marker' | 'none';
export type LinkCandidateKind = Exclude<CandidateKind, 'marker' | 'none'>;
export type AllowRule = 'allowlist' | 'web_result' | 'server_url' | 'user_message' | 'relative' | 'not_link';
export type RejectReason =
  | 'link_not_allowlisted'
  | 'link_obfuscated'
  | 'link_opaque_scheme'
  | 'link_userinfo'
  | 'link_host_changed';

export interface LinkDecision {
  allowed: boolean;
  rule: AllowRule | RejectReason;
  kind: CandidateKind;
}

export interface WebResultUrl {
  url: string;
  flagged?: boolean;
}

export interface OutputLinkPolicy {
  /** RAG_OUTPUT_LINK_ALLOWLIST plus the NEXT_PUBLIC_SITE_URL host, as built by parseLinkAllowlist. */
  allowlist: ReadonlySet<string>;
  webResultUrls: readonly WebResultUrl[];
  serverUrls: readonly string[];
  imageHosts: ImageHostAllowlist | null;
  userMessage: string;
  documentNames: readonly string[];
}

export interface OutputLinkPolicyInput {
  allowlistValue?: string | null;
  siteUrl?: string | null;
  webResultUrls?: readonly (string | WebResultUrl)[];
  serverUrls?: readonly string[];
  imageHosts?: ImageHostAllowlist | null;
  userMessage?: string | null;
  documentNames?: readonly string[];
}

export function createOutputLinkPolicy(input: OutputLinkPolicyInput): OutputLinkPolicy {
  return {
    allowlist: parseLinkAllowlist(input.allowlistValue, input.siteUrl),
    webResultUrls: (input.webResultUrls ?? []).map((entry) =>
      typeof entry === 'string' ? { url: entry, flagged: false } : { url: entry.url, flagged: entry.flagged === true },
    ),
    serverUrls: [...(input.serverUrls ?? [])],
    imageHosts: input.imageHosts ?? null,
    userMessage: input.userMessage ?? '',
    documentNames: [...(input.documentNames ?? [])],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rules data

export interface CompiledOutputGuardRules {
  version: string;
  rules: OutputGuardRules;
  obfuscation: readonly { id: string; regex: RegExp }[];
  opaqueSchemes: ReadonlySet<string>;
}

/** Validates an output-guard rules document (OutputGuardRules) and compiles its patterns; throws when it is invalid. */
export function compileOutputGuardRules(raw: unknown): CompiledOutputGuardRules {
  const rules = OutputGuardRulesSchema.parse(raw);
  return {
    version: rules.version,
    rules,
    obfuscation: (rules.obfuscation_patterns ?? []).map((item) => ({ id: item.id, regex: new RegExp(item.pattern, 'iu') })),
    opaqueSchemes: new Set(rules.opaque_schemes ?? []),
  };
}

let defaultRules: CompiledOutputGuardRules | null = null;

/** config/rag/output-guard-rules.json, validated and compiled once per process. */
export function defaultOutputGuardRules(): CompiledOutputGuardRules {
  if (!defaultRules) defaultRules = compileOutputGuardRules(rawRules);
  return defaultRules;
}

// ---------------------------------------------------------------------------------------------------------------
// Top-level domains

const PUBLIC_TLDS: ReadonlySet<string> = new Set(tldSnapshot.tlds);
const RECOGNIZED_TLDS: ReadonlySet<string> = new Set([...tldSnapshot.tlds, ...tldSnapshot.special_use]);

/** The IANA snapshot version line committed in config/rag/tld-snapshot.json. */
export const TLD_SNAPSHOT_VERSION: string = tldSnapshot.version;

function asciiLabel(label: string): string {
  const folded = label.normalize('NFKC').toLowerCase();
  if (/^[a-z0-9-]+$/.test(folded)) return folded;
  return domainToASCII(folded);
}

/** True when the label is a top-level domain of the committed IANA snapshot. */
export function isPublicTld(label: string): boolean {
  return PUBLIC_TLDS.has(asciiLabel(label));
}

/** The IANA list plus the special-use names (test, example, invalid, localhost, ...): what makes a bare domain. */
function isRecognizedTld(label: string): boolean {
  return RECOGNIZED_TLDS.has(asciiLabel(label));
}

// ---------------------------------------------------------------------------------------------------------------
// Host normalization

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_HOST = 253;

/**
 * The ASCII (punycode) form of the host of a host, authority or URL: NFKC, lower case, domainToASCII, one trailing
 * dot stripped. Null when NFKC changes the input, when user info is present, when the host holds an ideographic full
 * stop (IDNA would turn it into a dot) or when it is not a host.
 */
export function normalizeHost(raw: string): string | null {
  if (raw.normalize('NFKC') !== raw || raw === '' || /\s/u.test(raw)) return null;
  let rest = raw.toLowerCase();
  const scheme = SCHEME_PREFIX.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  else if (rest.startsWith('//')) rest = rest.slice(2);
  const authority = rest.split(/[/?#]/u)[0];
  if (authority.includes('@') || /[。｡\\]/u.test(authority)) return null;
  let host = authority.replace(/:\d*$/u, '');
  if (host.startsWith('[')) return /^\[[0-9a-f:.]+\]$/u.test(host) ? host : null;
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || host.endsWith('.')) return null;
  const ascii = domainToASCII(host);
  if (ascii === '' || ascii.length > MAX_HOST || ascii.split('.').some((label) => label === '')) return null;
  return ascii;
}

function normalizeHref(value: string): string | null {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Characters

const TERM =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿︐-︟︰-﹏！-－／：-？［-｀｛-･]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}\p{M}]/u;
const WHITESPACE = /\s/u;
const NOT_URL_BODY = new Set(['<', '>', '"', "'", '`', '\\', '{', '}', '|', '^', '[', ']']);
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '*', '_', '~']);
const SLOT_OPEN = new Set(['[', '(', '{']);
const SLOT_CLOSE = new Set([']', ')', '}']);
const SLOT_MAX = 6;
const SEPARATOR_WORD_MAX = 4;
const SEPARATOR_SPACE_MAX = 3;

/** Whitespace, a CJK character or CJK and full-width punctuation: a candidate never extends over one. */
export function isTerminator(char: string): boolean {
  return WHITESPACE.test(char) || TERM.test(char);
}
function isLabelChar(char: string): boolean {
  return char === '-' || char === '_' || char === '%' || (LETTER_OR_DIGIT.test(char) && !TERM.test(char));
}
function isDot(char: string): boolean {
  return char === '.' || char === '．';
}
function isAt(char: string): boolean {
  return char === '@' || char === '＠';
}
function isHostish(char: string): boolean {
  return isLabelChar(char) || isDot(char) || isAt(char) || char === '+';
}
/** A character that can continue a URL (no whitespace, CJK, quote, angle or square bracket). */
export function isUrlBody(char: string): boolean {
  if (char === '' || isTerminator(char) || NOT_URL_BODY.has(char)) return false;
  const code = char.charCodeAt(0);
  return code > 0x1f && code !== 0x7f;
}
function isHorizontalSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === ' ';
}
function isAsciiLetter(char: string): boolean {
  return /^[a-z]$/i.test(char);
}
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------
// Scanner

export interface LinkCandidate {
  kind: LinkCandidateKind;
  start: number;
  end: number;
  /** Set when the candidate was cut at the length bound: the decision is made on the text so far. */
  atBound: boolean;
  patternId?: string;
}

export type ScanStep =
  | { type: 'plain'; end: number }
  | { type: 'candidate'; candidate: LinkCandidate }
  | { type: 'markdown'; start: number; end: number; image: boolean; label: string; dest: string };

export interface ScanContext {
  rules: CompiledOutputGuardRules;
  /** Document names of this request's context blocks, folded. */
  documentNames: readonly string[];
  urlBound: number;
  linkTextBound: number;
  /** Up to HISTORY_LENGTH characters of input that precede `text`. */
  history: string;
}

export const HISTORY_LENGTH = 300;

class NeedMore {}
const NEED_MORE_SIGNAL = new NeedMore();

/**
 * Decides the next step at `pos`: a run of plain text, a link candidate or a Markdown link. Returns null when the
 * decision needs text that has not arrived yet (only when `final` is false). Every decision depends only on the text
 * it looked at, so a caller that waits on null gets the same steps whatever the split points.
 */
export function scanAt(text: string, pos: number, final: boolean, ctx: ScanContext): ScanStep | null {
  const peek = (index: number): string => {
    if (index < text.length) return text[index];
    if (final) return '';
    throw NEED_MORE_SIGNAL;
  };
  try {
    return scanStep(text, pos, peek, ctx);
  } catch (error) {
    if (error === NEED_MORE_SIGNAL) return null;
    throw error;
  }
}

function scanStep(text: string, i: number, peek: (index: number) => string, ctx: ScanContext): ScanStep {
  const char = text[i];
  if (char === '!') {
    if (peek(i + 1) === '[') {
      const markdown = scanMarkdown(text, i + 1, true, peek, ctx);
      if (markdown) return { ...markdown, start: i };
    }
    return { type: 'plain', end: i + 1 };
  }
  if (char === '[') return scanMarkdown(text, i, false, peek, ctx) ?? { type: 'plain', end: i + 1 };
  if (isLabelChar(char)) return scanWord(text, i, peek, ctx);
  return { type: 'plain', end: i + 1 };
}

function scanMarkdown(
  text: string,
  i: number,
  image: boolean,
  peek: (index: number) => string,
  ctx: ScanContext,
): Extract<ScanStep, { type: 'markdown' }> | null {
  let close = i + 1;
  for (;;) {
    if (close - (i + 1) >= ctx.linkTextBound) return null;
    const char = peek(close);
    if (char === '' || char === '[') return null;
    if (char === ']') break;
    close += 1;
  }
  if (peek(close + 1) !== '(') return null;
  let end = close + 2;
  let depth = 0;
  for (;;) {
    if (end - (close + 2) >= ctx.urlBound) return null;
    const char = peek(end);
    if (char === '' || char === '\n') return null;
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    end += 1;
  }
  const rawDest = text.slice(close + 2, end).trim();
  let dest = rawDest.split(/\s/u)[0] ?? '';
  if (rawDest.startsWith('<')) {
    const gt = rawDest.indexOf('>');
    dest = gt > 0 ? rawDest.slice(1, gt) : rawDest;
  }
  return { type: 'markdown', start: i, end: end + 1, image, label: text.slice(i + 1, close), dest };
}

function candidate(kind: LinkCandidateKind, start: number, end: number, atBound = false, patternId?: string): ScanStep {
  return { type: 'candidate', candidate: { kind, start, end, atBound, ...(patternId ? { patternId } : {}) } };
}

/** Consumes URL body characters from `from`; trims trailing sentence punctuation unless the bound was reached. */
function consumeBody(
  text: string,
  start: number,
  from: number,
  peek: (index: number) => string,
  ctx: ScanContext,
): { end: number; atBound: boolean } {
  let end = from;
  let depth = 0;
  for (;;) {
    if (end - start >= ctx.urlBound) return { end, atBound: true };
    const char = peek(end);
    if (!isUrlBody(char)) break;
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    end += 1;
  }
  while (end > from && TRAILING_PUNCTUATION.has(text[end - 1])) end -= 1;
  return { end, atBound: false };
}

function matchObfuscation(slot: string, ctx: ScanContext): string | null {
  const folded = slot.normalize('NFKC');
  for (const pattern of ctx.rules.obfuscation) if (pattern.regex.test(folded)) return pattern.id;
  return null;
}

/** A bracketed separator ("[.]") or a spelled-out one (" dot ") starting at `pos`, when a rule lists it. */
function readSlot(
  text: string,
  pos: number,
  peek: (index: number) => string,
  ctx: ScanContext,
): { end: number; id: string; spelled: boolean } | null {
  const open = peek(pos);
  if (SLOT_OPEN.has(open)) {
    for (let q = pos + 1; q <= pos + SLOT_MAX; q += 1) {
      const char = peek(q);
      if (char === '') return null;
      if (SLOT_CLOSE.has(char)) {
        const id = matchObfuscation(text.slice(pos, q + 1), ctx);
        if (!id) return null;
        const after = peek(q + 1);
        return isLabelChar(after) || after === '/' ? { end: q + 1, id, spelled: false } : null;
      }
    }
    return null;
  }
  if (!isHorizontalSpace(open)) return null;
  let q = pos;
  while (isHorizontalSpace(peek(q))) {
    q += 1;
    if (q - pos > SEPARATOR_SPACE_MAX) return null;
  }
  const wordStart = q;
  while (q - wordStart <= SEPARATOR_WORD_MAX && isAsciiLetter(peek(q))) q += 1;
  const wordLength = q - wordStart;
  if (wordLength === 0 || wordLength > SEPARATOR_WORD_MAX) return null;
  const spaceStart = q;
  while (isHorizontalSpace(peek(q))) {
    q += 1;
    if (q - spaceStart > SEPARATOR_SPACE_MAX) return null;
  }
  if (q === spaceStart || !isLabelChar(peek(q))) return null;
  const id = matchObfuscation(text.slice(pos, q), ctx);
  return id ? { end: q, id, spelled: true } : null;
}

/** Continues an obfuscated candidate over separators, labels and a path. Returns null when no separator follows. */
function extendObfuscated(
  text: string,
  start: number,
  pos: number,
  peek: (index: number) => string,
  ctx: ScanContext,
): { end: number; patternId: string; atBound: boolean } | null {
  let end = pos;
  let patternId: string | null = null;
  for (;;) {
    if (end - start >= ctx.urlBound) return patternId ? { end, patternId, atBound: true } : null;
    const slot = readSlot(text, end, peek, ctx);
    if (!slot) break;
    const body = consumeBody(text, start, slot.end, peek, ctx);
    if (slot.spelled) {
      const host = text.slice(slot.end, body.end).split(/[^\p{L}\p{N}\p{M}\-_%.．]/u)[0].replace(/[.．]+$/u, '');
      const labels = host.split(/[.．]/u);
      if (!isRecognizedTld(labels[labels.length - 1] ?? '')) break;
    }
    patternId ??= slot.id;
    end = body.end;
    if (body.atBound) return { end, patternId, atBound: true };
  }
  return patternId ? { end, patternId, atBound: false } : null;
}

function isEmailAddress(value: string): boolean {
  const ats = [...value].filter(isAt).length;
  if (ats !== 1) return false;
  const at = Math.max(value.indexOf('@'), value.indexOf('＠'));
  const local = value.slice(0, at);
  const labels = value.slice(at + 1).split(/[.．]/u);
  if (local === '' || [...local].some((char) => !(isLabelChar(char) || isDot(char) || char === '+'))) return false;
  if (labels.length < 2 || labels.some((label) => label === '' || [...label].some((char) => !isLabelChar(char)))) {
    return false;
  }
  const last = labels[labels.length - 1];
  return /^xn--/i.test(last) || (last.length >= 2 && /^\p{L}+$/u.test(last));
}

function trimTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && isDot(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

function isDocumentName(token: string, before: string, ctx: ScanContext): boolean {
  if (ctx.documentNames.length === 0) return false;
  const folded = fold(token);
  const withBefore = fold(before + token);
  return ctx.documentNames.some((name) => name === folded || (name.endsWith(folded) && withBefore.endsWith(name)));
}

function scanWord(text: string, i: number, peek: (index: number) => string, ctx: ScanContext): ScanStep {
  let k = i;
  while (k - i < ctx.urlBound && isHostish(peek(k))) k += 1;
  if (k - i >= ctx.urlBound) return classifyRun(text, i, k, '', peek, ctx, true);
  const next = peek(k);
  const run = text.slice(i, k);

  if (next === ':') {
    const first = peek(k + 1);
    if (first === '/' && peek(k + 2) === '/') {
      const scheme = fold(run);
      const body = consumeBody(text, i, k + 3, peek, ctx);
      if (scheme === 'http' || scheme === 'https') return candidate('url', i, body.end, body.atBound);
      const obfuscated = matchObfuscation(`${run}://`, ctx);
      if (obfuscated) {
        const extended = body.atBound ? null : extendObfuscated(text, i, body.end, peek, ctx);
        return candidate('obfuscated', i, extended?.end ?? body.end, extended?.atBound ?? body.atBound, obfuscated);
      }
      return candidate('opaque_scheme', i, body.end, body.atBound);
    }
    if (/^[a-z][a-z0-9+.-]*$/i.test(run) && first !== '' && isUrlBody(first)) {
      const scheme = run.toLowerCase();
      if (scheme === 'mailto' || ctx.rules.opaqueSchemes.has(scheme)) {
        const body = consumeBody(text, i, k + 1, peek, ctx);
        if (body.end > k + 1) return candidate(scheme === 'mailto' ? 'email' : 'opaque_scheme', i, body.end, body.atBound);
      }
    }
  }
  return classifyRun(text, i, k, next, peek, ctx, false);
}

function classifyRun(
  text: string,
  i: number,
  k: number,
  next: string,
  peek: (index: number) => string,
  ctx: ScanContext,
  atBound: boolean,
): ScanStep {
  let end = k;
  let run = text.slice(i, end);
  let following = next;
  const trimmedEmail = trimTrailingDots(run);
  if ([...run].some(isAt)) {
    if (isEmailAddress(trimmedEmail)) return candidate('email', i, i + trimmedEmail.length, atBound);
  }
  const cut = [...run].findIndex((char) => isAt(char) || char === '+');
  if (cut >= 0) {
    end = i + run.slice(0, cut).length;
    run = text.slice(i, end);
    following = text[end];
    atBound = false;
    if (run === '') return { type: 'plain', end: i + 1 };
  }
  const trimmed = trimTrailingDots(run);
  const trimmedEnd = i + trimmed.length;
  if (!atBound && trimmed === run && (SLOT_OPEN.has(following) || isHorizontalSpace(following))) {
    const obfuscated = extendObfuscated(text, i, trimmedEnd, peek, ctx);
    if (obfuscated) return candidate('obfuscated', i, obfuscated.end, obfuscated.atBound, obfuscated.patternId);
  }
  const labels = trimmed.split(/[.．]/u);
  if (labels.length >= 2 && labels.every((label) => label !== '')) {
    const www = fold(labels[0]) === 'www';
    const before = (ctx.history + text.slice(0, i)).slice(-HISTORY_LENGTH);
    if ((www || isRecognizedTld(labels[labels.length - 1])) && !isDocumentName(trimmed, before, ctx)) {
      let candidateEnd = trimmedEnd;
      let cutAtBound = atBound;
      if (!atBound && trimmed === run) {
        const extends_ =
          following === '/' || following === '?' || following === '#' || (following === ':' && /^\d$/.test(peek(end + 1)));
        if (extends_) {
          const body = consumeBody(text, i, end, peek, ctx);
          candidateEnd = body.end;
          cutAtBound = body.atBound;
        }
      }
      return candidate(www ? 'url' : 'bare_domain', i, candidateEnd, cutAtBound);
    }
  }
  return { type: 'plain', end };
}

// ---------------------------------------------------------------------------------------------------------------
// Classification and the allow rules

export interface ClassifyOptions {
  documentNames?: readonly string[];
  rules?: CompiledOutputGuardRules;
}

export const DEFAULT_URL_BOUND = 2048;
export const DEFAULT_LINK_TEXT_BOUND = 300;

export function scanContextFor(options: ClassifyOptions = {}, history = ''): ScanContext {
  return {
    rules: options.rules ?? defaultOutputGuardRules(),
    documentNames: (options.documentNames ?? []).map(fold).filter((name) => name !== ''),
    urlBound: DEFAULT_URL_BOUND,
    linkTextBound: DEFAULT_LINK_TEXT_BOUND,
    history,
  };
}

/** The kind of a complete candidate string, as the output guard's scanner sees it at the start of a word. */
export function classifyCandidate(text: string, options: ClassifyOptions = {}): CandidateKind {
  const value = text.trim();
  if (value === '') return 'none';
  const markers = findCitationMarkers(value);
  if (markers.length === 1 && markers[0].start === 0 && markers[0].end === value.length) return 'marker';
  const step = scanAt(value, 0, true, scanContextFor(options));
  if (step?.type === 'candidate' && step.candidate.start === 0 && step.candidate.end === value.length) {
    return step.candidate.kind;
  }
  return 'none';
}

function reject(rule: RejectReason, kind: CandidateKind): LinkDecision {
  return { allowed: false, rule, kind };
}

function allow(rule: AllowRule, kind: CandidateKind): LinkDecision {
  return { allowed: true, rule, kind };
}

/** Applies D-37 to a candidate of a known kind. */
export function decideLink(kind: CandidateKind, text: string, policy: OutputLinkPolicy): LinkDecision {
  if (kind === 'none' || kind === 'marker') return allow('not_link', kind);
  if (kind === 'obfuscated') return reject('link_obfuscated', kind);
  if (kind === 'opaque_scheme') return reject('link_opaque_scheme', kind);
  if (text.normalize('NFKC') !== text) return reject('link_host_changed', kind);

  if (kind === 'email') {
    const address = text.replace(/^mailto:/i, '').split('?')[0];
    const host = normalizeHost(address.slice(address.lastIndexOf('@') + 1));
    if (host && isAllowedHost(host, policy.allowlist)) return allow('allowlist', kind);
    if (address !== '' && policy.userMessage.includes(address)) return allow('user_message', kind);
    return reject('link_not_allowlisted', kind);
  }

  const schemed = SCHEME_PREFIX.test(text) ? text : text.startsWith('//') ? `https:${text}` : `http://${text}`;
  const scheme = schemed.slice(0, schemed.indexOf(':')).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return reject('link_opaque_scheme', kind);
  const authority = schemed.slice(schemed.indexOf('//') + 2).split(/[/?#]/u)[0];
  if (authority.includes('@')) return reject('link_userinfo', kind);
  let url: URL;
  try {
    url = new URL(schemed);
  } catch {
    return reject('link_not_allowlisted', kind);
  }
  if (url.username !== '' || url.password !== '') return reject('link_userinfo', kind);
  const host = normalizeHost(schemed);
  if (host === null) return reject('link_not_allowlisted', kind);
  if (isAllowedHost(host, policy.allowlist)) return allow('allowlist', kind);
  if (kind === 'url' && SCHEME_PREFIX.test(text)) {
    const href = url.href;
    if (policy.webResultUrls.some((entry) => !entry.flagged && normalizeHref(entry.url) === href)) {
      return allow('web_result', kind);
    }
    if (policy.serverUrls.some((entry) => normalizeHref(entry) === href)) return allow('server_url', kind);
    if (policy.imageHosts && isAllowedImageUrl(text, policy.imageHosts)) return allow('server_url', kind);
  }
  if (policy.userMessage.includes(text)) return allow('user_message', kind);
  return reject('link_not_allowlisted', kind);
}

/** Classifies a candidate string and applies the four allow rules of D-37. */
export function isLinkAllowed(
  candidateText: string,
  policy: OutputLinkPolicy,
  options: { rules?: CompiledOutputGuardRules } = {},
): LinkDecision {
  const value = candidateText.trim();
  const kind = classifyCandidate(value, { documentNames: policy.documentNames, rules: options.rules });
  return decideLink(kind, value, policy);
}
