import {
  DEFAULT_LINK_TEXT_BOUND,
  DEFAULT_URL_BOUND,
  HISTORY_LENGTH,
  classifyCandidate,
  decideLink,
  defaultOutputGuardRules,
  isUrlBody,
  scanAt,
  type CandidateKind,
  type CompiledOutputGuardRules,
  type LinkDecision,
  type OutputLinkPolicy,
  type ScanContext,
  type ScanStep,
} from './link-targets';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';
import { fixedText } from '@/lib/rag/lang/texts';
import { compileCredentialRules, isWordChar, matchCredentialSentence, type CompiledCredentialRule } from './credential-rules';
import { normalise } from './injection-scan';

/**
 * The output guard's pure core (D-35, D-36, D-38): links, domains and e-mail addresses in answer text. `push` releases
 * text up to a possible link start and holds a candidate until it is complete or reaches its bound; `flush` decides
 * what is held as it stands. guardWholeText runs the same core over a whole text, so both give the same output and
 * summary whatever the split points. No regular expression runs over the unbounded tail: every step scans forward
 * from its start and stops at a bound.
 *
 * Credential sentences (D-39) run on the link stage's output: text streams until a credential-rule term starts, then
 * the rest of the sentence is held until a sentence end or the sentence bound and decided there. A matching sentence
 * is blocked when the turn had flagged context or the answer removed a link before the decision point, and kept with
 * a warning otherwise; a link removed later turns an already released warning into a recorded blocked range.
 */

export type OutputGuardMode = 'flag' | 'enforce';

export const DEFAULT_SENTENCE_BOUND = 600;

export type OutputGuardNoticeKind = 'credential_request_warning' | 'credential_request_blocked';

/** A notice the caller emits through the notice emitter (D-11); requested at most once per kind and guard, enforce only. */
export interface OutputGuardNotice {
  kind: OutputGuardNoticeKind;
  textId: string;
}

/** A released sentence blocked late: UTF-16 offsets into the released text of `textId` (the caller adds part and hash). */
export interface OutputGuardBlockedRange {
  textId: string;
  start: number;
  end: number;
}

export interface OutputGuardPolicy {
  mode: OutputGuardMode;
  links: OutputLinkPolicy;
  /** The registry text notices.link_removed in the answer language. */
  placeholder: string;
  rules?: CompiledOutputGuardRules;
  bounds?: { url?: number; linkText?: number; sentence?: number };
  /** A context item of the turn was flagged (injection_check, a quarantine release, a flagged tool result). */
  flaggedContext?: boolean;
  onNotice?: (notice: OutputGuardNotice) => void;
  /** The registry text notices.credential_request_blocked; resolved from `language` when not given. */
  credentialBlocked?: string;
  language?: string;
}

/** The serializable OutputGuardSummary fields; removedTargets is non-enumerable and never serialized. */
export interface OutputGuardLinkSummary {
  mode: OutputGuardMode;
  rules_version: string;
  links_checked: number;
  links_removed: number;
  credential_blocked: number;
  credential_warned: number;
  rule_ids: string[];
  /** In memory only, for source attribution; never logged, stored or serialized. */
  readonly removedTargets: readonly string[];
  /** In memory only: released sentences blocked after a later link removal (enforce). */
  readonly blockedRanges: readonly OutputGuardBlockedRange[];
}

export interface OutputGuard {
  /** Appends a delta of text block `textId` and returns the text that may be released. */
  push(textId: string, delta: string): string;
  /** Decides the held text of `textId` as it stands and returns it. */
  flush(textId: string): string;
  /** Flushes every text block that still holds text, in the order they were first pushed. */
  flushAll(): { textId: string; text: string }[];
  summary(): OutputGuardLinkSummary;
}

interface TextState {
  pending: string;
  history: string;
  /** After a URL decided at its bound: the rest of its characters are kept or dropped with it. */
  tail: 'keep' | 'drop' | null;
}

interface Counters {
  checked: number;
  removed: number;
  ruleIds: string[];
  removedTargets: string[];
  /** Credential rule ids, reported after the link rule ids so the order does not depend on the split points. */
  credentialRuleIds: string[];
  credentialBlocked: number;
  credentialWarned: number;
}

interface CredentialState {
  pending: string;
  /** Offset of pending[0] in the link stage's output of this text. */
  base: number;
  /** Length of the text released for this text so far. */
  out: number;
  /** The last normalised character before pending, for the word-boundary check. */
  prevNorm: string;
  buffering: boolean;
  firstRemoval: number;
}

interface WarnedSentence {
  textId: string;
  start: number;
  end: number;
  /** Decision point in the link stage's output of its text. */
  decidedAt: number;
}


const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const UNSAFE_RELATIVE = /[\s\\\u0000-\u001f\u007f]/u;

export function createOutputGuard(policy: OutputGuardPolicy): OutputGuard {
  const rules = policy.rules ?? defaultOutputGuardRules();
  const enforce = policy.mode === 'enforce';
  const documentNames = policy.links.documentNames.map((name) => name.normalize('NFKC').toLowerCase()).filter(Boolean);
  const urlBound = policy.bounds?.url ?? DEFAULT_URL_BOUND;
  const linkTextBound = policy.bounds?.linkText ?? DEFAULT_LINK_TEXT_BOUND;
  const states = new Map<string, TextState>();
  const counters: Counters = {
    checked: 0,
    removed: 0,
    ruleIds: [],
    removedTargets: [],
    credentialRuleIds: [],
    credentialBlocked: 0,
    credentialWarned: 0,
  };
  const credential = createCredentialStage(policy, rules, counters);

  const contextFor = (history: string): ScanContext => ({ rules, documentNames, urlBound, linkTextBound, history });

  const addRule = (id: string | undefined) => {
    if (id && !counters.ruleIds.includes(id)) counters.ruleIds.push(id);
  };

  const record = (decision: LinkDecision, target: string, patternId?: string) => {
    counters.checked += 1;
    if (decision.allowed) return;
    counters.removed += 1;
    addRule(decision.rule);
    addRule(patternId);
    counters.removedTargets.push(target);
  };

  const decideDestination = (dest: string): LinkDecision => {
    if (dest === '' || dest.startsWith('#')) return { allowed: true, rule: 'relative', kind: 'none' };
    let kind: CandidateKind;
    if (SCHEME.test(dest)) {
      kind = classifyCandidate(dest, { documentNames: policy.links.documentNames, rules });
      if (kind === 'none' || kind === 'marker') kind = 'opaque_scheme';
    } else if (dest.startsWith('//')) {
      kind = 'url';
    } else {
      if (UNSAFE_RELATIVE.test(dest)) return { allowed: false, rule: 'link_not_allowlisted', kind: 'none' };
      kind = classifyCandidate(dest, { documentNames: policy.links.documentNames, rules });
      if (kind === 'none' || kind === 'marker') return { allowed: true, rule: 'relative', kind: 'none' };
    }
    return decideLink(kind, dest, policy.links);
  };

  const render = (step: ScanStep, text: string, state: TextState): string => {
    if (step.type === 'plain') return text.slice(0, step.end);
    if (step.type === 'candidate') {
      const { candidate } = step;
      const token = text.slice(candidate.start, candidate.end);
      const decision = decideLink(candidate.kind, token, policy.links);
      record(decision, token, candidate.patternId);
      if (candidate.atBound) state.tail = decision.allowed ? 'keep' : 'drop';
      return decision.allowed || !enforce ? token : policy.placeholder;
    }
    const original = text.slice(step.start, step.end);
    const decision = decideDestination(step.dest);
    record(decision, step.dest);
    const label = processWhole(step.label);
    if (!enforce) return original;
    const prefix = step.image ? '![' : '[';
    if (decision.allowed) return prefix + label + original.slice(prefix.length + step.label.length);
    if (step.image) return policy.placeholder;
    return label === '' ? policy.placeholder : `${label} ${policy.placeholder}`;
  };

  const process = (state: TextState, final: boolean, removals?: number[]): string => {
    const text = state.pending;
    const ctx = contextFor(state.history);
    let out = '';
    let pos = 0;
    while (pos < text.length) {
      if (state.tail) {
        let end = pos;
        while (end < text.length && isUrlBody(text[end]) && text[end] !== ')') end += 1;
        if (state.tail === 'keep' || !enforce) out += text.slice(pos, end);
        pos = end;
        if (end < text.length) state.tail = null;
        continue;
      }
      const step = scanAt(text, pos, final, ctx);
      if (!step) break;
      const end = step.type === 'candidate' ? step.candidate.end : step.end;
      const removedBefore = counters.removed;
      const piece = render(shift(step, pos), text.slice(pos), state);
      if (removals && counters.removed > removedBefore) removals.push(out.length);
      out += piece;
      pos = end;
    }
    state.history = (state.history + text.slice(0, pos)).slice(-HISTORY_LENGTH);
    state.pending = text.slice(pos);
    if (final) state.tail = null;
    return out;
  };

  const processWhole = (text: string): string => {
    const state: TextState = { pending: text, history: '', tail: null };
    return process(state, true);
  };

  const stateOf = (textId: string): TextState => {
    let state = states.get(textId);
    if (!state) {
      state = { pending: '', history: '', tail: null };
      states.set(textId, state);
    }
    return state;
  };

  return {
    push(textId, delta) {
      if (delta.length === 0) return '';
      const state = stateOf(textId);
      state.pending += delta;
      const removals: number[] = [];
      const linked = process(state, false, removals);
      return credential.feed(textId, linked, removals, false);
    },
    flush(textId) {
      const state = states.get(textId);
      const removals: number[] = [];
      const linked = state ? process(state, true, removals) : '';
      states.delete(textId);
      return credential.feed(textId, linked, removals, true);
    },
    flushAll() {
      const out: { textId: string; text: string }[] = [];
      for (const textId of [...states.keys()]) out.push({ textId, text: this.flush(textId) });
      return out;
    },
    summary() {
      const summary = {
        mode: policy.mode,
        rules_version: rules.version,
        links_checked: counters.checked,
        links_removed: counters.removed,
        credential_blocked: counters.credentialBlocked,
        credential_warned: counters.credentialWarned,
        rule_ids: [...counters.ruleIds, ...counters.credentialRuleIds],
      };
      Object.defineProperty(summary, 'removedTargets', {
        value: Object.freeze([...counters.removedTargets]),
        enumerable: false,
      });
      Object.defineProperty(summary, 'blockedRanges', {
        value: Object.freeze(credential.blockedRanges().map((range) => Object.freeze({ ...range }))),
        enumerable: false,
      });
      return summary as OutputGuardLinkSummary;
    },
  };
}

/** Re-bases a step found at `offset` so that render can work on text.slice(offset). */
function shift(step: ScanStep, offset: number): ScanStep {
  if (step.type === 'plain') return { type: 'plain', end: step.end - offset };
  if (step.type === 'candidate') {
    return {
      type: 'candidate',
      candidate: { ...step.candidate, start: step.candidate.start - offset, end: step.candidate.end - offset },
    };
  }
  return { ...step, start: step.start - offset, end: step.end - offset };
}

/** Replaces each blocked range of `textId` in its released text with `replacement`. */
export function applyBlockedRanges(
  text: string,
  ranges: readonly OutputGuardBlockedRange[],
  replacement: string,
  textId = 'answer',
): string {
  const own = ranges.filter((range) => range.textId === textId).sort((a, b) => b.start - a.start);
  let out = text;
  for (const range of own) out = out.slice(0, range.start) + replacement + out.slice(range.end);
  return out;
}

/**
 * The whole-text twin of the stream adapter: push then flush on the same core. A late block is exact here: the
 * recorded ranges are replaced, so the result carries no blocked ranges.
 */
export function guardWholeText(text: string, policy: OutputGuardPolicy): { text: string; summary: OutputGuardLinkSummary } {
  const guard = createOutputGuard(policy);
  const out = guard.push('answer', text) + guard.flush('answer');
  const summary = guard.summary();
  if (summary.blockedRanges.length === 0) return { text: out, summary };
  const exact = applyBlockedRanges(out, summary.blockedRanges, credentialBlockedText(policy));
  const settled = { ...summary };
  Object.defineProperty(settled, 'removedTargets', { value: summary.removedTargets, enumerable: false });
  Object.defineProperty(settled, 'blockedRanges', { value: Object.freeze([]), enumerable: false });
  return { text: exact, summary: settled as OutputGuardLinkSummary };
}

// ---------------------------------------------------------------------------------------------------------------
// Credential sentences (D-39)

interface SentenceEnds {
  /** Marks that end a sentence only before whitespace or the end of the text (spaced scripts). */
  spaced: ReadonlySet<string>;
  /** Marks that end a sentence at once (full-width marks of unspaced scripts). */
  immediate: ReadonlySet<string>;
}

let sentenceEnds: SentenceEnds | null = null;

function registrySentenceEnds(): SentenceEnds {
  if (!sentenceEnds) {
    const spaced = new Set<string>();
    const immediate = new Set<string>();
    for (const pack of getLanguageRegistry().packs) {
      for (const mark of Array.from(pack.sentence_end)) {
        if (/^[\x21-\x7e]$/.test(mark)) spaced.add(mark);
        else immediate.add(mark);
      }
    }
    sentenceEnds = { spaced, immediate };
  }
  return sentenceEnds;
}

function credentialBlockedText(policy: OutputGuardPolicy): string {
  return policy.credentialBlocked ?? fixedText('notices.credential_request_blocked', policy.language ?? '');
}

const WHITESPACE = /\s/u;

/** One code point through the shared normaliser; whitespace becomes a single space. */
function normChar(char: string): string {
  if (WHITESPACE.test(char)) return ' ';
  return normalise(char, '');
}

function lastChar(text: string): string {
  return text === '' ? '' : (text[text.length - 1] as string);
}

interface TermIndex {
  terms: readonly string[];
  firstChars: ReadonlySet<string>;
  maxLength: number;
}

const termIndexCache = new WeakMap<readonly CompiledCredentialRule[], TermIndex>();

function termIndexOf(rules: readonly CompiledCredentialRule[]): TermIndex {
  let index = termIndexCache.get(rules);
  if (!index) {
    const terms = [...new Set(rules.flatMap((rule) => [...rule.request, ...rule.secret]))];
    index = {
      terms,
      firstChars: new Set(terms.map((term) => term[0] as string)),
      maxLength: terms.reduce((max, term) => Math.max(max, term.length), 0),
    };
    termIndexCache.set(rules, index);
  }
  return index;
}

/**
 * Whether a credential term starts at text[i]: 'match' when a whole term is there with its boundaries, 'maybe' when
 * the text ends before that can be told (not final), 'no' otherwise. Compares normalised characters.
 */
function termStartAt(text: string, i: number, prevNorm: string, final: boolean, index: TermIndex): 'match' | 'maybe' | 'no' {
  const firstPoint = String.fromCodePoint(text.codePointAt(i) as number);
  const first = normChar(firstPoint);
  if (first === '' || first === ' ' || !index.firstChars.has(first[0] as string)) return 'no';
  let normalised = '';
  let j = i;
  while (j < text.length && normalised.length <= index.maxLength) {
    const point = String.fromCodePoint(text.codePointAt(j) as number);
    const n = normChar(point);
    if (!(n === ' ' && normalised.endsWith(' '))) normalised += n;
    j += point.length;
  }
  const exhausted = j >= text.length && !final;
  const prevWord = isWordChar(lastChar(prevNorm));
  let maybe = false;
  for (const term of index.terms) {
    if (term[0] !== normalised[0]) continue;
    if (prevWord && isWordChar(term[0])) continue;
    if (normalised.startsWith(term)) {
      if (!isWordChar(term[term.length - 1])) return 'match';
      if (normalised.length > term.length) {
        if (!isWordChar(normalised[term.length])) return 'match';
      } else if (exhausted) {
        maybe = true;
      } else {
        return 'match';
      }
    } else if (exhausted && term.startsWith(normalised)) {
      maybe = true;
    }
  }
  return maybe ? 'maybe' : 'no';
}

function isHighSurrogate(char: string | undefined): boolean {
  return char !== undefined && char >= '\ud800' && char <= '\udbff';
}

/** The end of the held sentence (exclusive), or -1 while it cannot be told yet. */
function sentenceEnd(text: string, final: boolean, bound: number): number {
  const ends = registrySentenceEnds();
  for (let j = 0; j < text.length; j += 1) {
    if (j >= bound) {
      const cut = isHighSurrogate(text[bound - 1]) ? bound + 1 : bound;
      return cut <= text.length ? cut : final ? text.length : -1;
    }
    const char = text[j] as string;
    if (char === '\n') return j;
    if (ends.immediate.has(char)) return j + 1;
    if (ends.spaced.has(char)) {
      if (j + 1 < text.length) {
        if (WHITESPACE.test(text[j + 1] as string)) return j + 1;
      } else {
        return final ? j + 1 : -1;
      }
    }
  }
  return final ? text.length : -1;
}

interface CredentialStage {
  feed(textId: string, text: string, removals: readonly number[], final: boolean): string;
  blockedRanges(): OutputGuardBlockedRange[];
}

function createCredentialStage(
  policy: OutputGuardPolicy,
  rules: CompiledOutputGuardRules,
  counters: Counters,
): CredentialStage {
  const compiled = compileCredentialRules(rules.rules);
  const index = termIndexOf(compiled);
  const enforce = policy.mode === 'enforce';
  const bound = policy.bounds?.sentence ?? DEFAULT_SENTENCE_BOUND;
  const states = new Map<string, CredentialState>();
  const textsWithRemoval = new Set<string>();
  const warned: WarnedSentence[] = [];
  const ranges: OutputGuardBlockedRange[] = [];
  const notified = new Set<OutputGuardNoticeKind>();
  let blockedText: string | null = null;

  const notify = (kind: OutputGuardNoticeKind, textId: string) => {
    if (!enforce || notified.has(kind)) return;
    notified.add(kind);
    policy.onNotice?.({ kind, textId });
  };

  const addRule = (id: string) => {
    if (!counters.credentialRuleIds.includes(id)) counters.credentialRuleIds.push(id);
  };

  const decide = (textId: string, state: CredentialState, sentence: string, decidedAt: number): string => {
    const ids = matchCredentialSentence(sentence, undefined, compiled);
    if (ids.length === 0) return sentence;
    ids.forEach(addRule);
    const removedElsewhere = [...textsWithRemoval].some((id) => id !== textId);
    if (policy.flaggedContext === true || removedElsewhere || state.firstRemoval < decidedAt) {
      counters.credentialBlocked += 1;
      notify('credential_request_blocked', textId);
      if (!enforce) return sentence;
      blockedText ??= credentialBlockedText(policy);
      return blockedText;
    }
    counters.credentialWarned += 1;
    notify('credential_request_warning', textId);
    warned.push({ textId, start: state.out, end: state.out + sentence.length, decidedAt });
    return sentence;
  };

  const run = (textId: string, state: CredentialState, final: boolean): string => {
    let out = '';
    const take = (length: number): string => {
      const piece = state.pending.slice(0, length);
      state.pending = state.pending.slice(length);
      state.base += length;
      return piece;
    };
    for (;;) {
      if (!state.buffering) {
        let prev = state.prevNorm;
        let i = 0;
        let hold = false;
        while (i < state.pending.length) {
          const result = termStartAt(state.pending, i, prev, final, index);
          if (result === 'match') {
            state.buffering = true;
            break;
          }
          if (result === 'maybe') {
            hold = true;
            break;
          }
          const point = String.fromCodePoint(state.pending.codePointAt(i) as number);
          const n = normChar(point);
          if (n !== '') prev = n;
          i += point.length;
        }
        const released = take(i);
        state.out += released.length;
        state.prevNorm = prev;
        out += released;
        if (hold || !state.buffering) return out;
      }
      const end = sentenceEnd(state.pending, final, bound);
      if (end < 0) return out;
      const decidedAt = state.base + end;
      const sentence = take(end);
      const text = decide(textId, state, sentence, decidedAt);
      state.out += text.length;
      state.buffering = false;
      const tail = normChar(String.fromCodePoint(sentence.codePointAt(sentence.length - 1) as number));
      if (tail !== '') state.prevNorm = tail;
      out += text;
      if (state.pending.length === 0) return out;
    }
  };

  const lateBlocks = (textId: string, at: number) => {
    for (let k = 0; k < warned.length; ) {
      const sentence = warned[k] as WarnedSentence;
      if (sentence.textId !== textId || at >= sentence.decidedAt) {
        warned.splice(k, 1);
        counters.credentialWarned -= 1;
        counters.credentialBlocked += 1;
        if (enforce) ranges.push({ textId: sentence.textId, start: sentence.start, end: sentence.end });
        notify('credential_request_blocked', sentence.textId);
      } else {
        k += 1;
      }
    }
  };

  return {
    feed(textId, text, removals, final) {
      let state = states.get(textId);
      if (!state) {
        state = { pending: '', base: 0, out: 0, prevNorm: '', buffering: false, firstRemoval: Number.POSITIVE_INFINITY };
        states.set(textId, state);
      }
      const offset = state.base + state.pending.length;
      const absolute = removals.map((at) => offset + at);
      for (const at of absolute) state.firstRemoval = Math.min(state.firstRemoval, at);
      state.pending += text;
      const out = run(textId, state, final);
      if (absolute.length > 0) {
        textsWithRemoval.add(textId);
        for (const at of absolute) lateBlocks(textId, at);
      }
      if (final) states.delete(textId);
      return out;
    },
    blockedRanges() {
      return ranges.map((range) => ({ ...range }));
    },
  };
}
