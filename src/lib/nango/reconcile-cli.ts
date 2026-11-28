export type ParsedReconcileArgs = { ok: true; connectionId: string | null; maxSeconds: number } | { ok: false; error: string };

export interface CliIo {
    out: (line: string) => void;
    err: (line: string) => void;
}

export const USAGE = 'usage: npm run rag:source-reconcile -- [--connection <id>] [--max-seconds 50]';

export function parseReconcileArgs(_argv: string[]): ParsedReconcileArgs {
    return { ok: true, connectionId: null, maxSeconds: 50 };
}

export async function main(_argv: string[] = [], _io?: CliIo, _signal?: AbortSignal): Promise<number> {
    return 0;
}
