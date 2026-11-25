import type { HistoryTurn } from '../types';

export interface HistoryWindowLimits {
  turns: number;
  chars: number;
}

export function buildHistoryWindow(_messages: unknown, _limits?: Partial<HistoryWindowLimits>): HistoryTurn[] {
  return [];
}
