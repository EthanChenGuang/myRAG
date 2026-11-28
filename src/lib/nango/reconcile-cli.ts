import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

export type ParsedReconcileArgs = { ok: true; connectionId: string | null; maxSeconds: number } | { ok: false; error: string };

export interface CliIo {
    out: (line: string) => void;
    err: (line: string) => void;
}

export const DEFAULT_MAX_SECONDS = 50;
const MAX_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG = '[Source Reconcile]';

export const USAGE = 'usage: npm run rag:source-reconcile -- [--connection <id>] [--max-seconds 50]';

const WITH_VALUE = new Set(['--connection', '--max-seconds']);

/** `[--connection <nango_connections.id>] [--max-seconds 1..600]`. */
export function parseReconcileArgs(argv: string[]): ParsedReconcileArgs {
    const values = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i] as string;
        if (!WITH_VALUE.has(arg)) return { ok: false, error: `unknown option: ${arg}` };
        const value = argv[(i += 1)];
        if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
        if (values.has(arg)) return { ok: false, error: `${arg} was given twice` };
        values.set(arg, value);
    }

    const connectionId = values.get('--connection') ?? null;
    if (connectionId !== null && !UUID.test(connectionId)) {
        return { ok: false, error: '--connection needs a connection id (a UUID)' };
    }

    let maxSeconds = DEFAULT_MAX_SECONDS;
    const rawSeconds = values.get('--max-seconds');
    if (rawSeconds !== undefined) {
        const parsed = /^\d+$/.test(rawSeconds) ? Number(rawSeconds) : Number.NaN;
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SECONDS) {
            return { ok: false, error: `--max-seconds needs an integer from 1 to ${MAX_SECONDS}` };
        }
        maxSeconds = parsed;
    }

    return { ok: true, connectionId, maxSeconds };
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/**
 * CLI entry. Prints counts only. Exit code 0 when done, 1 on a database failure or a missing
 * SUPABASE_SERVICE_ROLE_KEY, 2 on bad arguments.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal): Promise<number> {
    const parsed = parseReconcileArgs(argv);
    if (!parsed.ok) {
        io.err(`${TAG} ${parsed.error}`);
        io.err(USAGE);
        return 2;
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
        io.err(`${TAG} refused: set SUPABASE_SERVICE_ROLE_KEY`);
        return 1;
    }

    const { runSourceReconcile } = await import('./reconcile');
    try {
        const result = await runSourceReconcile({
            deadlineMs: parsed.maxSeconds * 1000,
            ...(parsed.connectionId !== null ? { connectionId: parsed.connectionId } : {}),
            ...(signal ? { signal } : {}),
        });
        io.out(
            `${TAG} processed=${result.processed} removed=${result.removed} paused=${result.paused} incomplete=${result.incomplete} ` +
                `failed=${result.failed} skipped=${result.skipped} overdue=${result.overdue} ` +
                `purge_retried=${result.purgeRetried} purge_still_pending=${result.purgeStillPending} purge_rescrubbed=${result.purgeRescrubbed} ` +
                `purge_skipped=${result.purgeSkipped} purge_failed=${result.purgeFailed}`
        );
        return 0;
    } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        io.err(`${TAG} database failure${typeof code === 'string' ? ` (${code})` : ''}`);
        return 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    loadDotenv({ path: '.env.local', quiet: true });
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort(new Error('interrupted')));
    main(process.argv.slice(2), consoleIo, controller.signal).then(
        (code) => process.exit(code),
        (error) => {
            console.error(`${TAG} failed:`, error instanceof Error ? error.name : 'unknown');
            process.exit(1);
        }
    );
}
