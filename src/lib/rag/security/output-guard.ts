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

/**
 * The output guard's pure core (D-35, D-36, D-38): links, domains and e-mail addresses in answer text. `push` releases
 * text up to a possible link start and holds a candidate until it is complete or reaches its bound; `flush` decides
 * what is held as it stands. guardWholeText runs the same core over a whole text, so both give the same output and
 * summary whatever the split points. No regular expression runs over the unbounded tail: every step scans forward
 * from its start and stops at a bound.
 */

export type OutputGuardMode = 'flag' | 'enforce';

export interface OutputGuardPolicy {
  mode: OutputGuardMode;
  links: OutputLinkPolicy;
  /** The registry text notices.link_removed in the answer language. */
  placeholder: string;
  rules?: CompiledOutputGuardRules;
  bounds?: { url?: number; linkText?: number };
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
  const counters: Counters = { checked: 0, removed: 0, ruleIds: [], removedTargets: [] };

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

  const process = (state: TextState, final: boolean): string => {
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
      out += render(shift(step, pos), text.slice(pos), state);
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
      return process(state, false);
    },
    flush(textId) {
      const state = states.get(textId);
      if (!state) return '';
      const out = process(state, true);
      states.delete(textId);
      return out;
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
        credential_blocked: 0,
        credential_warned: 0,
        rule_ids: [...counters.ruleIds],
      };
      Object.defineProperty(summary, 'removedTargets', {
        value: Object.freeze([...counters.removedTargets]),
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

/** The whole-text twin of the stream adapter: push then flush on the same core. */
export function guardWholeText(text: string, policy: OutputGuardPolicy): { text: string; summary: OutputGuardLinkSummary } {
  const guard = createOutputGuard(policy);
  const out = guard.push('answer', text) + guard.flush('answer');
  return { text: out, summary: guard.summary() };
}
