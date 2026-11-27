export const KICK_BUDGET_MS = 10_000;
export const KICK_TARGETS_TTL_MS = 30_000;

export interface KickDeps {
  now?: () => number;
}

export function kickVectorSync(_deps: KickDeps = {}): void {}

export function resetVectorSyncKickForTests(): void {}
