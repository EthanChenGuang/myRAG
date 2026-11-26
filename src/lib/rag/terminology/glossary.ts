import type { TerminologyMatch } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../backend/supabase-rpc';
import { FALLBACK_STAGE_TIMEOUT_MS, loadRagConfig, type RagConfig } from '../config';
import { getRagDeps } from '../deps';
import type { TenantScope } from '../tenant/scope';
import type { Profile } from '../types';
import { expandMatches, terminologyParams } from './expand';
import { terminologyMatcherFor } from './load';

/** D-20: the entries that match a text, and the effective dictionary version they come from. */
export interface TerminologyGlossary {
  matches: TerminologyMatch[];
  version: string;
}

export interface TerminologyGlossaryOptions {
  /** Absent: the terminology stage timeout of the profile. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The profile whose stage timeout applies; absent means chat. */
  profile?: Profile;
  /** Absent: the configuration from the deps' env. */
  config?: RagConfig;
  /** Tests: the service-role client and the clock, passed through to the loader. */
  client?: RpcClient;
  now?: () => number;
}

function enabled(config: RagConfig): boolean {
  return config.v2.terminology && !config.disabledStages.has('terminology');
}

/**
 * D-20, D-22: matches any text (a rewrite or HyDE prompt about to be sent) against the tenant's cached matcher, the same cache the
 * stage uses. Null when the switch is off, the load fails or the timeout passes. It never throws, records no stage, logs nothing
 * and changes nothing in retrieval. Translation pairs never match (the matcher is built without them, D-32).
 */
export async function terminologyGlossary(
  scope: TenantScope,
  text: string,
  options: TerminologyGlossaryOptions = {},
): Promise<TerminologyGlossary | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const config = options.config ?? loadRagConfig(getRagDeps().ragEnv());
    if (!enabled(config) || options.signal?.aborted) return null;
    const timeoutMs = options.timeoutMs ?? config.timeouts[options.profile ?? 'chat'].terminology ?? FALLBACK_STAGE_TIMEOUT_MS;
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const params = terminologyParams();
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const matched = (async (): Promise<TerminologyGlossary> => {
      const { dictionary, matcher } = await terminologyMatcherFor(scope, {
        signal,
        minHanChars: params.min_han_chars,
        ...(options.client ? { client: options.client } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      return { matches: expandMatches(text, matcher.match(text), params).matches, version: dictionary.version };
    })();
    // A late rejection after the timeout won the race must not surface as unhandled.
    matched.catch(() => undefined);
    return await Promise.race([matched, timedOut]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
