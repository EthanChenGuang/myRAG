import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import type { Profile } from '../types';
import { detectLanguageWithConfidence } from './detect';
import { requestLanguageId } from './langid-client';

export type QueryLanguageSource = NonNullable<QueryPlan['language_detection']>['source'];

/** D-17: the resolved query language, its confidence in [0, 1] and the chain step that decided it. */
export interface QueryLanguageDetection {
  language: string;
  confidence: number;
  source: QueryLanguageSource;
}

export interface ResolveQueryLanguageParams {
  language_confidence_threshold: number;
  langid_timeout_ms: number;
}

export interface ResolveQueryLanguageInput {
  text: string;
  /** RAG_SUPPORTED_LANGUAGES, through getLanguageSettings(). */
  enabled: readonly string[];
  /** RAG_PRIMARY_LANGUAGE; the last step of the chain. */
  primary: string;
  previousTurnLanguage?: string | null;
  uiLanguage?: string | null;
  profile: Profile;
  params: ResolveQueryLanguageParams;
  signal?: AbortSignal;
  /** Chain step 1 (D-17): RAG_LANGID_SIDECAR with the sidecar configured; `request` is a test seam. */
  sidecar?: { enabled: boolean; request?: typeof requestLanguageId } | null;
}

const SIDECAR_PROFILES: ReadonlySet<Profile> = new Set<Profile>(['chat', 'embed', 'eval']);
const DOMINANT_SCRIPT_SHARE = 0.7;
const SHORT_MAX_WORDS = 3;
const CODE_DOMINATED_SHARE = 0.5;
const CODE_TOKEN = /[\d_/\\=#@$%&*+<>{}()[\]|~^`]|\p{Ll}\p{Lu}|\p{L}[.:]\p{L}/u;
const TRAILING_PUNCTUATION = /[.,;:!?。，！？、]+$/u;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A language code reduced to its primary subtag, kept only when it is enabled. */
export function enabledLanguage(code: string | null | undefined, enabled: readonly string[]): string | null {
  if (typeof code !== 'string') return null;
  const primary = code.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
  return primary !== '' && enabled.includes(primary) ? primary : null;
}

function tokens(text: string): string[] {
  return text.split(/\s+/u).filter((token) => token !== '');
}

function isCodeToken(token: string): boolean {
  return CODE_TOKEN.test(token.replace(TRAILING_PUNCTUATION, ''));
}

function codeDominated(text: string): boolean {
  const all = tokens(text).filter((token) => token.replace(TRAILING_PUNCTUATION, '') !== '');
  if (all.length === 0) return false;
  return all.filter(isCodeToken).length / all.length > CODE_DOMINATED_SHARE;
}

/** The text without code tokens: identifiers, paths and numbers carry no language evidence. */
function proseOf(text: string): string {
  return tokens(text)
    .filter((token) => !isCodeToken(token))
    .join(' ');
}

function wordCount(text: string): number {
  return tokens(text).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * D-17 low-confidence rules on the prose (code tokens removed), script check first: mixed Han and Latin text without a
 * dominant script is low; a Han-dominant text is never "short"; otherwise three words or fewer, code-dominated text (on the
 * full text), a tie or a confidence under the threshold.
 */
function confidentDetection(
  text: string,
  prose: string,
  threshold: number,
  detection: { confident: boolean; confidence: number },
): boolean {
  if (!detection.confident) return false;
  const han = count(prose, /\p{Script=Han}/gu);
  const latin = count(prose, /\p{Script=Latin}/gu);
  const letters = han + latin;
  if (letters === 0) return false;
  if (han > 0 && latin > 0 && Math.max(han, latin) / letters < DOMINANT_SCRIPT_SHARE) return false;
  const hanDominant = han / letters >= DOMINANT_SCRIPT_SHARE;
  if (!hanDominant && wordCount(prose) <= SHORT_MAX_WORDS) return false;
  if (codeDominated(text)) return false;
  return detection.confidence >= threshold;
}

/**
 * LANG-08 (D-17): the query language among the enabled languages. One enabled language skips detection. A confident
 * detection wins; otherwise the chain runs and the first step that answers wins: the sidecar language ID (switch on, chat,
 * embed and eval only, never voice), the previous turn's language, the UI language, then the primary language. Caller-supplied hints count only when they name an enabled language. Never logs text.
 */
export async function resolveQueryLanguage(input: ResolveQueryLanguageInput): Promise<QueryLanguageDetection> {
  const enabled = [...new Set(input.enabled)];
  const primary = enabledLanguage(input.primary, enabled) ?? enabled[0] ?? input.primary;
  if (enabled.length === 1) return { language: enabled[0]!, confidence: 1, source: 'single_language' };
  if (enabled.length === 0) return { language: primary, confidence: 0, source: 'primary' };

  const prose = proseOf(input.text);
  const detection = detectLanguageWithConfidence(prose, enabled);
  const confidence = clamp01(detection.confidence);
  const detected = enabledLanguage(detection.language, enabled);
  if (detected && confidentDetection(input.text, prose, input.params.language_confidence_threshold, detection)) {
    return { language: detected, confidence, source: 'detector' };
  }

  if (input.sidecar?.enabled && SIDECAR_PROFILES.has(input.profile) && !input.signal?.aborted) {
    const request = input.sidecar.request ?? requestLanguageId;
    const answer = await request(input.text, enabled, {
      timeoutMs: input.params.langid_timeout_ms,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const language = enabledLanguage(answer?.language, enabled);
    if (answer && language) return { language, confidence: clamp01(answer.confidence), source: 'sidecar' };
  }

  const previous = enabledLanguage(input.previousTurnLanguage, enabled);
  if (previous) return { language: previous, confidence, source: 'previous_turn' };
  const ui = enabledLanguage(input.uiLanguage, enabled);
  if (ui) return { language: ui, confidence, source: 'ui_language' };
  return { language: primary, confidence, source: 'primary' };
}
