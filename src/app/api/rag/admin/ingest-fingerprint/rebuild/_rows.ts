import type { RebuildRunRow } from '@/lib/rag';

/** UI-SPEC 6.4.2 state badges: a complete run with an activation step is built; an activated one is active. */
function uiState(run: RebuildRunRow): string {
  switch (run.state) {
    case 'complete':
      return run.activation === 'none' ? 'completed' : 'built';
    case 'activated':
      return 'active';
    default:
      return run.state;
  }
}

/** One row of the Rebuilds table (UI-SPEC 8.1): counts, state, start time and the activation that applies. */
export function rebuildRow(run: RebuildRunRow) {
  return {
    id: run.id,
    mechanism: run.mechanism,
    done: run.done,
    total: run.total,
    gaps: run.gaps,
    state: uiState(run),
    started: run.startedAt,
    activation: run.activation,
  };
}
