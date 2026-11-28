import { z } from 'zod/v3';
import type { InjectionDetectorConfig } from '@/lib/rag-eval/contracts.generated';
import type { InjectionCheckMode, SecurityConfig } from './config';
import type { Detector, DetectorClassifyOptions, DetectorOutcome } from './detectors';

export const DEFAULT_LAKERA_BASE_URL = 'https://api.lakera.ai';
const GUARD_PATH = '/v2/guard';
const DEFAULT_TIMEOUT_MS = 400;
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const LAKERA_LEVELS = ['l1_confident', 'l2_very_likely', 'l3_likely', 'l4_less_likely', 'l5_unlikely'] as const;
export type LakeraLevel = (typeof LAKERA_LEVELS)[number];

export type LakeraGateRefusal = 'check_off' | 'lakera_off' | 'not_configured' | 'multi_tenant_ack_missing';

export type LakeraUnavailableReason =
  | LakeraGateRefusal
  | 'profile_disabled'
  | 'too_large'
  | 'aborted'
  | 'timeout'
  | 'network'
  | 'http_400'
  | 'http_401'
  | 'http_422'
  | 'http_429'
  | 'http_500'
  | 'http_503'
  | 'http_error'
  | 'malformed'
  | 'no_breakdown'
  | 'detector_missing';

export interface LakeraGateInput {
  injectionCheck: InjectionCheckMode;
  lakera: boolean;
  multiTenant: boolean;
  ack: boolean;
  apiKeyPresent: boolean;
}

export type LakeraGateResult = { allowed: true; reason: null } | { allowed: false; reason: LakeraGateRefusal };

/**
 * The only gate for a Lakera request: the injection check is on, Lakera is on, a key is present, and the deployment
 * is single-tenant or the multi-tenant retention acknowledgement is set. A refusal carries the first failing reason.
 */
export function lakeraAllowed(input: LakeraGateInput): LakeraGateResult {
  if (input.injectionCheck === 'off') return { allowed: false, reason: 'check_off' };
  if (input.lakera !== true) return { allowed: false, reason: 'lakera_off' };
  if (input.apiKeyPresent !== true) return { allowed: false, reason: 'not_configured' };
  if (input.multiTenant !== false && input.ack !== true) return { allowed: false, reason: 'multi_tenant_ack_missing' };
  return { allowed: true, reason: null };
}

/** Read per request; the key never leaves this module except in the authorization header. */
export interface LakeraSettings {
  injectionCheck: InjectionCheckMode;
  lakera: boolean;
  multiTenant: boolean;
  ack: boolean;
  apiKey: string | null;
  baseUrl: string;
}

export function lakeraSettingsFrom(security: SecurityConfig, multiTenant: boolean): LakeraSettings {
  return {
    injectionCheck: security.injectionCheck,
    lakera: security.lakera,
    multiTenant,
    ack: security.lakeraMultiTenantAck,
    apiKey: security.lakeraApiKey,
    baseUrl: security.lakeraBaseUrl,
  };
}

const BreakdownEntry = z
  .object({
    detector_type: z.string(),
    detected: z.boolean(),
    result: z.string().optional(),
  })
  .passthrough();

const GuardResponse = z
  .object({
    breakdown: z.array(BreakdownEntry).nullish(),
  })
  .passthrough();

export type LakeraVerdictResult =
  | { kind: 'verdict'; flagged: boolean; level: LakeraLevel | null }
  | { kind: 'unavailable'; reason: 'malformed' | 'no_breakdown' | 'detector_missing' };

function levelRank(level: string | undefined): number | null {
  const index = LAKERA_LEVELS.indexOf(level as LakeraLevel);
  return index === -1 ? null : index;
}

/**
 * The verdict comes from breakdown entries of a configured detector type, never from the top-level `flagged` field,
 * which is always false in detect mode. With min_level set, a detected entry at a less confident level does not
 * count; a detected entry without a known level still counts. No configured detector in the breakdown means the
 * policy did not screen for it, which is unavailable rather than clean.
 */
export function lakeraVerdict(
  body: unknown,
  detectorTypes: readonly string[],
  minLevel: LakeraLevel | null,
): LakeraVerdictResult {
  const parsed = GuardResponse.safeParse(body);
  if (!parsed.success) return { kind: 'unavailable', reason: 'malformed' };
  const breakdown = parsed.data.breakdown;
  if (!breakdown) return { kind: 'unavailable', reason: 'no_breakdown' };
  const relevant = breakdown.filter((entry) => detectorTypes.includes(entry.detector_type));
  if (relevant.length === 0) return { kind: 'unavailable', reason: 'detector_missing' };
  const limit = minLevel === null ? null : levelRank(minLevel);
  let flagged = false;
  let best: number | null = null;
  for (const entry of relevant) {
    if (entry.detected !== true) continue;
    const rank = levelRank(entry.result);
    if (rank !== null && (best === null || rank < best)) best = rank;
    if (limit === null || rank === null || rank <= limit) flagged = true;
  }
  return { kind: 'verdict', flagged, level: best === null ? null : LAKERA_LEVELS[best] };
}

export interface LakeraDetectorDeps {
  config: InjectionDetectorConfig['lakera'];
  fetch: typeof fetch;
  /** Evaluated before every request, so a switch turned off mid-run stops further requests. */
  gate: () => LakeraSettings;
  timeoutMs?: number;
  now?: () => number;
}

const HTTP_REASONS: Readonly<Record<number, LakeraUnavailableReason>> = {
  400: 'http_400',
  401: 'http_401',
  422: 'http_422',
  429: 'http_429',
  500: 'http_500',
  503: 'http_503',
};

class Aborted extends Error {}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function unavailable(reason: LakeraUnavailableReason): DetectorOutcome<LakeraUnavailableReason> {
  return { kind: 'unavailable', reason };
}

function guardUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return `${trimmed === '' ? DEFAULT_LAKERA_BASE_URL : trimmed}${GUARD_PATH}`;
}

async function cancelBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** One chunk per request: Lakera documents no per-message verdict semantics or size limits for batches. */
export function createLakeraDetector(deps: LakeraDetectorDeps): Detector<LakeraUnavailableReason> {
  const { config } = deps;
  const timeoutMs = deps.timeoutMs !== undefined && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const version = `guard-v2:${config.detector_types.join('+')}:${config.min_level ?? 'any'}`;

  async function screen(text: string, opts: DetectorClassifyOptions): Promise<DetectorOutcome<LakeraUnavailableReason>> {
    const settings = deps.gate();
    const apiKey = settings.apiKey?.trim() ?? '';
    const gate = lakeraAllowed({
      injectionCheck: settings.injectionCheck,
      lakera: settings.lakera,
      multiTenant: settings.multiTenant,
      ack: settings.ack,
      apiKeyPresent: apiKey !== '',
    });
    if (!gate.allowed) return unavailable(gate.reason);
    if (opts.signal.aborted) return unavailable('aborted');
    if (text.length > config.max_chars) return unavailable('too_large');

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([opts.signal, timeout]);
    const failure = (): DetectorOutcome<LakeraUnavailableReason> =>
      unavailable(opts.signal.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'network');
    const traceId = opts.traceId !== null && TRACE_ID_RE.test(opts.traceId) ? opts.traceId : null;

    let res: Response;
    const pending = deps.fetch(guardUrl(settings.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: text }],
        breakdown: true,
        ...(traceId !== null ? { metadata: { internal_request_id: traceId } } : {}),
      }),
      signal,
    });
    try {
      res = await raceAbort(pending, signal);
    } catch {
      pending.then(cancelBody, () => undefined);
      return failure();
    }
    if (!res.ok) {
      await cancelBody(res);
      return unavailable(HTTP_REASONS[res.status] ?? 'http_error');
    }
    let body: unknown;
    try {
      body = await raceAbort(res.json() as Promise<unknown>, signal);
    } catch (error) {
      if (error instanceof Aborted) {
        await cancelBody(res);
        return failure();
      }
      return unavailable('malformed');
    }
    const verdict = lakeraVerdict(body, config.detector_types, config.min_level);
    if (verdict.kind === 'unavailable') return unavailable(verdict.reason);
    return { kind: 'verdict', verdict: { flagged: verdict.flagged, level: verdict.level, at: now() } };
  }

  return {
    id: 'lakera',
    version,
    async classify(items, opts) {
      if (!config.profiles.includes(opts.profile)) return items.map(() => unavailable('profile_disabled'));
      const outcomes = new Array<DetectorOutcome<LakeraUnavailableReason>>(items.length);
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const index = next;
          next += 1;
          try {
            outcomes[index] = await screen(items[index], opts);
          } catch {
            outcomes[index] = unavailable('network');
          }
        }
      };
      const workers = Math.max(1, Math.min(config.concurrency, items.length));
      await Promise.all(Array.from({ length: workers }, worker));
      return outcomes;
    },
  };
}
