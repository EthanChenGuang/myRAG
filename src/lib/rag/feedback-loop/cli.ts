import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import { readFeedbackLoopConfig } from './config';
import { purgeRetrievalLog, PurgeError } from './purge';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliDeps {
  env?: Record<string, string | undefined>;
  createClient?: (url: string, key: string) => SupabaseClient;
}

export const USAGE = ['usage: npm run rag:feedback-loop -- purge', '  purge  delete retrieval log rows older than RAG_RETRIEVAL_LOG_RETENTION_DAYS and expired open review items'].join('\n');

const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

function serviceClient(url: string, key: string): SupabaseClient {
  return createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * The CLI body. Prints counts and variable names only, never a value. Returns the exit code: 0 done, 1 the database refused, 2 the
 * arguments or the environment were wrong. The environment must already be loaded.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, deps: CliDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'purge' || rest.length > 0) {
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
