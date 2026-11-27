import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { isTenantKey } from '../../ingest/writer';

/**
 * `npm run rag:scope-centroids -- --tenant <key> [--profile <id>]`: rebuilds one tenant's scope centroids for the active (or named)
 * embedding profile and re-embeds the tenant's out-of-scope examples into it (D-25). Prints counts only. Exit 0 when done, 1 on a
 * backend failure, 2 on bad arguments or an unknown profile.
 */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export type ParsedScopeCentroidArgs =
  | { ok: true; help: boolean; tenantKey: string | null; profileId: string | null }
  | { ok: false; error: string };

export const USAGE = 'usage: npm run rag:scope-centroids -- --tenant <key> [--profile <id>]';

const WITH_VALUE = new Set(['--tenant', '--profile']);
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

export function parseScopeCentroidArgs(argv: string[]): ParsedScopeCentroidArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') return { ok: true, help: true, tenantKey: null, profileId: null };
    if (!WITH_VALUE.has(arg)) return { ok: false, error: `unknown option: ${arg}` };
    const value = argv[(i += 1)];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
    if (values.has(arg)) return { ok: false, error: `${arg} was given twice` };
    values.set(arg, value);
  }
  const tenantKey = values.get('--tenant');
  if (tenantKey === undefined) return { ok: false, error: '--tenant <key> is required' };
  if (!isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };
  const profileId = values.get('--profile') ?? null;
  if (profileId !== null && !PROFILE_ID.test(profileId)) return { ok: false, error: '--profile needs an embedding profile id' };
  return { ok: true, help: false, tenantKey, profileId };
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal): Promise<number> {
  const parsed = parseScopeCentroidArgs(argv);
  if (!parsed.ok) {
    io.err(`[Scope Gate] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (parsed.help) {
    io.out(USAGE);
    return 0;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err('[Scope Gate] refused: set SUPABASE_SERVICE_ROLE_KEY');
    return 1;
  }

  const { storeScopeForTenantKey } = await import('../../tenant/store-scope');
  const { LEGACY_PROFILE, getEmbeddingProfileById, isEmbeddingProfilesEnabled } = await import('../../embeddings/active-profile');
  const { ScopeRebuildError, rebuildScopeCentroids } = await import('../build');

  let scope;
  try {
    scope = storeScopeForTenantKey(parsed.tenantKey as string);
  } catch {
    io.err('[Scope Gate] --tenant needs a canonical tenant key');
    io.err(USAGE);
    return 2;
  }

  let profile;
  if (parsed.profileId !== null) {
    if (parsed.profileId === LEGACY_PROFILE.id && !isEmbeddingProfilesEnabled()) profile = LEGACY_PROFILE;
    else {
      try {
        profile = await getEmbeddingProfileById(parsed.profileId);
      } catch {
        io.err('[Scope Gate] unknown_profile');
        return 2;
      }
    }
  }

  try {
    const result = await rebuildScopeCentroids(scope, { reembedExamples: true, ...(profile ? { profile } : {}), ...(signal ? { signal } : {}) });
    io.out(`[Scope Gate] ${result.tenantKey} profile ${result.profileId}`);
    for (const kind of ['doc_type', 'scope_tag', 'tenant'] as const) {
      io.out(`[Scope Gate] ${kind}: ${result.counts[kind].groups} groups, ${result.counts[kind].chunks} chunks`);
    }
    io.out(`[Scope Gate] examples: ${result.examples.reembedded} re-embedded, ${result.examples.skipped} present, ${result.examples.failed} failed`);
    io.out(`[Scope Gate] done in ${result.durationMs} ms`);
    return 0;
  } catch (error) {
    if (error instanceof ScopeRebuildError) {
      io.err(`[Scope Gate] ${error.code}${error.sqlState ? ` (${error.sqlState})` : ''}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('interrupted')));
  main(process.argv.slice(2), consoleIo, controller.signal).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error('[Scope Gate] failed', error instanceof Error ? { error: error.name } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
