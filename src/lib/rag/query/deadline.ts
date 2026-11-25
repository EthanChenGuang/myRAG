import type { Profile } from '../types';

export const GROUP_DEADLINE_CAP_MS = 0;
export const QUERY_BUDGET_MS: Partial<Record<Profile, number>> = {};

export function groupDeadlineMs(_args: {
  profile: Profile;
  elapsedMs: number;
  cacheTimeoutMs: number;
  queryBudgetMs?: number;
}): number | null {
  return 0;
}

export function groupDeadlineSignal(_ms: number | null): AbortSignal | null {
  return null;
}

export function transformSignal(request: AbortSignal, _group: AbortSignal | null, _timeoutMs: number | null): AbortSignal {
  return request;
}

export function transformAbortReason(_request: AbortSignal, _signal: AbortSignal): 'timeout' | 'aborted' | null {
  return null;
}
