import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import { readFeedbackLoopConfig } from './config';
import { isMiningWindowError, MiningError, parseMiningDate, runMining, type MiningWindowInput } from './mining';
import { purgeRetrievalLog, PurgeError } from './purge';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliDeps {
  env?: Record<string, string | undefined>;
  createClient?: (url: string, key: string) => SupabaseClient;
}

export const USAGE = [
  'usage: npm run rag:feedback-loop -- purge',
  '       npm run rag:feedback-loop -- mine [--since YYYY-MM-DD] [--until YYYY-MM-DD]',
  '  purge  delete retrieval log rows older than RAG_RETRIEVAL_LOG_RETENTION_DAYS and expired open review items',
  '  mine   purge, then mine [since, until) into the review queue (until: now; since: until minus window_days; at most 31 days)',
].join('\n');

const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

function serviceClient(url: string, key: string): SupabaseClient {
  return createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** `--since D` and `--until D`, each at most once, as YYYY-MM-DD; null when anything else is given. */
function parseMineArguments(args: string[]): MiningWindowInput | null {
  const window: MiningWindowInput = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--since' && flag !== '--until') || value === undefined) return null;
    const key = flag === '--since' ? 'since' : 'until';
    if (window[key] !== undefined) return null;
    const date = parseMiningDate(value);
    if (!date) return null;
    window[key] = date;
  }
  return window;
}

async function mine(window: MiningWindowInput, client: SupabaseClient, env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  try {
    const result = await runMining(window, { client, env, log: (line) => io.err(line) });
    io.out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const code = error instanceof MiningError ? error.code : 'unknown';
    io.err(`[Feedback Loop] mining failed (${code})`);
    return isMiningWindowError(error) ? 2 : 1;
  }
}

/**
 * The CLI body. Prints counts and variable names only, never a value. Returns the exit code: 0 done, 1 the database refused, 2 the
 * arguments or the environment were wrong. The environment must already be loaded.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, deps: CliDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  let window: MiningWindowInput = {};
  if (command === 'mine') {
    const parsed = parseMineArguments(rest);
    if (!parsed) {
      io.err('[Feedback Loop] mine takes --since and --until as YYYY-MM-DD dates, each at most once');
      io.err(USAGE);
      return 2;
    }
    window = parsed;
  } else if (command !== 'purge' || rest.length > 0) {
    io.err(command === undefined ? '[Feedback Loop] a subcommand is required' : '[Feedback Loop] unknown subcommand or argument');
    io.err(USAGE);
    return 2;
  }

  const env = deps.env ?? process.env;
  const missing = REQUIRED_ENV.filter((name) => (env[name]?.trim() ?? '') === '');
  if (missing.length > 0) {
    io.err(`[Feedback Loop] set ${missing.join(' and ')} to run with the service role`);
    return 2;
  }
  const client = (deps.createClient ?? serviceClient)(env.NEXT_PUBLIC_SUPABASE_URL!.trim(), env.SUPABASE_SERVICE_ROLE_KEY!.trim());
  if (command === 'mine') return mine(window, client, env, io);
  const { retentionDays } = readFeedbackLoopConfig(env, (line) => io.err(line));

  try {
    const counts = await purgeRetrievalLog(client, retentionDays);
    io.out(
      `[Feedback Loop] purge: deleted ${counts.logRows} retrieval log rows older than ${retentionDays} days and ${counts.reviewItems} expired open review items`,
    );
    return 0;
  } catch (error) {
    io.err(`[Feedback Loop] purge failed (${error instanceof PurgeError ? error.code : 'unknown'})`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  main(process.argv.slice(2), consoleIo).then(
    (code) => process.exit(code),
    () => {
      console.error('[Feedback Loop] failed');
      process.exit(1);
    },
  );
}
