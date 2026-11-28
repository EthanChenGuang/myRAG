import type { Profile } from '../types';

/** D-27: the parallel group never runs longer than this. */
export const GROUP_DEADLINE_CAP_MS = 900;

/** QueryParams.query_budget_ms: the whole pre-retrieval query stage, chat and embed. */
export const QUERY_BUDGET_MS: Readonly<Partial<Record<Profile, number>>> = Object.freeze({
  chat: 1200,
  embed: 1200,
});

export type GroupDeadlineArgs = {
  profile: Profile;
  /** Time since `query_gate` started (A-7 anchor), not since condense ended. */
  elapsedMs: number;
  /** The semantic-cache stage timeout still to come after the group; 0 when the cache is off. */
  cacheTimeoutMs: number;
  queryBudgetMs?: number;
};

/**
 * min(900, budget - cache timeout - elapsed), floored at 0. Null means no group deadline:
 * voice runs no parallel group, eval has no timeouts (D-27), media runs no query layer.
 */
export function groupDeadlineMs(args: GroupDeadlineArgs): number | null {
  const budget = args.queryBudgetMs ?? QUERY_BUDGET_MS[args.profile];
  if (budget === undefined) return null;
  const remaining = budget - args.cacheTimeoutMs - args.elapsedMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.floor(Math.min(GROUP_DEADLINE_CAP_MS, remaining));
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('query transform deadline elapsed', 'TimeoutError'));
  }, Math.max(0, ms));
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

/** One signal per parallel group, shared by every transform in it. */
export function groupDeadlineSignal(ms: number | null): AbortSignal | null {
  return ms === null ? null : timeoutSignal(ms);
}

/** Aborts when the request, the group deadline or the per-transform timeout does. */
export function transformSignal(request: AbortSignal, group: AbortSignal | null, timeoutMs: number | null): AbortSignal {
  const signals: AbortSignal[] = [request];
  if (group) signals.push(group);
  if (timeoutMs !== null) signals.push(timeoutSignal(timeoutMs));
  return AbortSignal.any(signals);
}

/** Runner semantics: a request abort is `aborted`; a group or transform deadline is `timeout`. */
export function transformAbortReason(request: AbortSignal, signal: AbortSignal): 'timeout' | 'aborted' | null {
  if (request.aborted) return 'aborted';
  if (signal.aborted) return 'timeout';
  return null;
}
