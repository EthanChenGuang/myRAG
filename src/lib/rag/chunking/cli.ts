import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { RetrievalBackendError } from '../backend/supabase-rpc';
import type { CreateChunkingProfileInput } from './profile-ops';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export type ParsedChunkingArgs =
  | { ok: true; command: 'status' }
  | { ok: true; command: 'create'; input: CreateChunkingProfileInput }
  | { ok: true; command: 'record-decision'; decisionPath: string }
  | { ok: true; command: 'activate'; profileId: string; docType: string | null; actor: string | null }
  | { ok: true; command: 'rollback'; docType: string; actor: string | null }
  | { ok: false; error: string };

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DOC_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_INT = /^[1-9][0-9]{0,8}$/;
const PRESETS: Record<string, { childTokens: number; parentTokens: number }> = {
  '128/512': { childTokens: 128, parentTokens: 512 },
  '256/1024': { childTokens: 256, parentTokens: 1024 },
  '256/2048': { childTokens: 256, parentTokens: 2048 },
};
const PARENT_MODES = ['none', 'structure', 'fixed'] as const;

export const USAGE = [
  'usage: npm run rag:chunking -- status',
  '       npm run rag:chunking -- create <id> --doc-type <type> --preset 128/512|256/1024|256/2048',
  '       npm run rag:chunking -- create <id> --doc-type <type> --preset custom --child-tokens <n> [--parent-mode none|structure|fixed] [--parent-tokens <n>]',
  '       npm run rag:chunking -- record-decision <decision.json>',
  '       npm run rag:chunking -- activate <id> [--doc-type <type>] [--actor <admin user uuid>]',
  '       npm run rag:chunking -- rollback <doc_type> [--actor <admin user uuid>]',
  'exit codes: 0 done, 1 database error or missing service key, 2 wrong arguments or invalid profile or decision, 3 refused by an activation gate',
].join('\n');

function parseFlags(rest: string[], allowed: readonly string[]): { ok: true; values: Map<string, string> } | { ok: false; error: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] as string;
    if (!allowed.includes(flag)) return { ok: false, error: `unknown option: ${flag}` };
    const value = rest[(i += 1)];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} needs a value` };
    if (values.has(flag)) return { ok: false, error: `${flag} was given twice` };
    values.set(flag, value);
  }
  return { ok: true, values };
}

function parseActor(values: Map<string, string>): { ok: true; actor: string | null } | { ok: false; error: string } {
  const actor = values.get('--actor') ?? null;
  if (actor !== null && !UUID.test(actor)) return { ok: false, error: '--actor needs an admin user uuid' };
  return { ok: true, actor };
}

export function parseChunkingArgs(argv: string[]): ParsedChunkingArgs {
  const [command, ...rest] = argv;
  switch (command) {
    case 'status':
      return rest.length === 0 ? { ok: true, command: 'status' } : { ok: false, error: 'status takes no arguments' };
    case 'record-decision':
      return rest.length === 1 && !(rest[0] as string).startsWith('--')
        ? { ok: true, command: 'record-decision', decisionPath: rest[0] as string }
        : { ok: false, error: 'record-decision needs one decision file' };
    case 'create': {
      const id = rest[0];
      if (id === undefined || !PROFILE_ID.test(id)) return { ok: false, error: 'create needs a profile id (lower-case letters, digits, ._-)' };
      const flags = parseFlags(rest.slice(1), ['--doc-type', '--preset', '--child-tokens', '--parent-mode', '--parent-tokens']);
      if (!flags.ok) return flags;
      const typeName = flags.values.get('--doc-type');
      if (typeName === undefined || !DOC_TYPE.test(typeName)) return { ok: false, error: 'create needs --doc-type <type>' };
      const presetName = flags.values.get('--preset');
      if (presetName === undefined || (presetName !== 'custom' && !(presetName in PRESETS))) {
        return { ok: false, error: 'create needs --preset 128/512, 256/1024, 256/2048 or custom' };
      }
      const rawChild = flags.values.get('--child-tokens');
      const rawParent = flags.values.get('--parent-tokens');
      const rawMode = flags.values.get('--parent-mode');
      if ((rawChild !== undefined && !POSITIVE_INT.test(rawChild)) || (rawParent !== undefined && !POSITIVE_INT.test(rawParent))) {
        return { ok: false, error: '--child-tokens and --parent-tokens need positive integers' };
      }
      if (rawMode !== undefined && !(PARENT_MODES as readonly string[]).includes(rawMode)) {
        return { ok: false, error: '--parent-mode needs none, structure or fixed' };
      }
      if (presetName !== 'custom') {
        if (rawChild !== undefined || rawParent !== undefined) return { ok: false, error: '--child-tokens and --parent-tokens go with --preset custom' };
        const preset = PRESETS[presetName] as { childTokens: number; parentTokens: number };
        return {
          ok: true,
          command: 'create',
          input: {
            id,
            docType: typeName,
            childTokens: preset.childTokens,
            parentMode: (rawMode as CreateChunkingProfileInput['parentMode'] | undefined) ?? 'structure',
            parentTokens: rawMode === 'none' ? null : preset.parentTokens,
            preset: presetName as CreateChunkingProfileInput['preset'],
          },
        };
      }
      if (rawChild === undefined) return { ok: false, error: '--preset custom needs --child-tokens <n>' };
      const parentTokens = rawParent === undefined ? null : Number(rawParent);
      return {
        ok: true,
        command: 'create',
        input: {
          id,
          docType: typeName,
          childTokens: Number(rawChild),
          parentMode: (rawMode as CreateChunkingProfileInput['parentMode'] | undefined) ?? (parentTokens === null ? 'none' : 'structure'),
          parentTokens,
          preset: 'custom',
        },
      };
    }
    case 'activate': {
      const profileId = rest[0];
      if (profileId === undefined || !PROFILE_ID.test(profileId)) return { ok: false, error: 'activate needs a profile id' };
      const flags = parseFlags(rest.slice(1), ['--doc-type', '--actor']);
      if (!flags.ok) return flags;
      const typeName = flags.values.get('--doc-type') ?? null;
      if (typeName !== null && !DOC_TYPE.test(typeName)) return { ok: false, error: '--doc-type needs a document type name' };
      const actor = parseActor(flags.values);
      if (!actor.ok) return actor;
      return { ok: true, command: 'activate', profileId, docType: typeName, actor: actor.actor };
    }
    case 'rollback': {
      const typeName = rest[0];
      if (typeName === undefined || !DOC_TYPE.test(typeName)) return { ok: false, error: 'rollback needs a doc type' };
      const flags = parseFlags(rest.slice(1), ['--actor']);
      if (!flags.ok) return flags;
      const actor = parseActor(flags.values);
      if (!actor.ok) return actor;
      return { ok: true, command: 'rollback', docType: typeName, actor: actor.actor };
    }
    default:
      return { ok: false, error: command === undefined ? 'a command is required' : `unknown command: ${command}` };
  }
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

function percent(withChildren: number, ready: number): string {
  return (ready === 0 ? 100 : (withChildren * 100) / ready).toFixed(1);
}

/**
 * The CLI body. Prints profile ids, doc types, statuses, counts and the gate's refusal words only: never a key and never stored text.
 * Returns the exit code: 0 done, 1 the database failed or the service key is missing, 2 the arguments, profile or decision were wrong, 3 an
 * activation gate refused. The environment must already be loaded.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal): Promise<number> {
  const parsed = parseChunkingArgs(argv);
  if (!parsed.ok) {
    io.err(`[RAG Chunking] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    io.err('[RAG Chunking] SUPABASE_SERVICE_ROLE_KEY is not set: the operations call service-role functions and will not run without it');
    return 1;
  }
  const ops = await import('./profile-ops');
  const options = signal ? { signal } : {};

  const notV2 = async (): Promise<void> => {
    const { loadRagConfig } = await import('../config');
    const { getRagDeps } = await import('../deps');
    if (loadRagConfig(getRagDeps().ragEnv()).pipeline !== 'v2') {
      io.out('[RAG Chunking] warning: RAG_PIPELINE is not v2, so retrieval ignores the chunking pointer until it is');
    }
  };

  try {
    if (parsed.command === 'status') {
      const [profiles, coverage, state] = await Promise.all([ops.listChunkingProfiles(options), ops.getChunkingCoverage(options), ops.getChunkingProfileState(options)]);
      const coverageOf = new Map(coverage.map((row) => [`${row.docType}\u0000${row.profileId}`, row]));
      const stateOf = new Map(state.map((row) => [`${row.docType}\u0000${row.profileId}`, row]));
      const byType = new Map<string, typeof profiles>();
      for (const profile of profiles) byType.set(profile.docType, [...(byType.get(profile.docType) ?? []), profile]);
      for (const [type, members] of [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const active = members.find((profile) => profile.isActive);
        io.out(`[RAG Chunking] doc type ${type}: active ${active?.id ?? 'none'}`);
        for (const profile of members) {
          const key = `${type}\u0000${profile.id}`;
          const covered = coverageOf.get(key);
          const ready = covered?.currentReadyDocuments ?? 0;
          const withChildren = covered?.documentsWithChildren ?? 0;
          const parent = profile.parentMode === 'none' ? 'none' : `${profile.parentMode}/${profile.parentTokens ?? 'none'}`;
          io.out(
            `[RAG Chunking]   profile ${profile.id} status=${profile.status} child=${profile.childTokens} parent=${parent} completeness=${withChildren}/${ready} (${percent(withChildren, ready)}%) open_gaps=${stateOf.get(key)?.openGaps ?? 0} decision=${stateOf.get(key)?.evidence ?? 'none'}`,
          );
          if (profile.isActive && profile.id !== 'legacy' && (covered?.missingDocuments ?? 0) > 0) {
            io.out(
              `[RAG Chunking]   missing from active profile: ${covered?.missingDocuments} (served from legacy chunks; run npm run rag:rechunk -- --profile ${profile.id})`,
            );
          }
        }
      }
      await notV2();
      return 0;
    }

    if (parsed.command === 'create') {
      const { validateChunkingProfile } = await import('./validate');
      const verdict = await validateChunkingProfile({
        id: parsed.input.id,
        doc_type: parsed.input.docType,
        child_tokens: parsed.input.childTokens,
        parent_mode: parsed.input.parentMode,
        parent_tokens: parsed.input.parentTokens,
        status: 'building',
        preset: parsed.input.preset,
      });
      for (const warning of verdict.warnings) io.out(`[RAG Chunking] warning: ${warning}`);
      if (verdict.errors.length > 0) {
        for (const error of verdict.errors) io.err(`[RAG Chunking] invalid profile: ${error}`);
        return 2;
      }
      const created = await ops.createChunkingProfile(parsed.input, options);
      io.out(`[RAG Chunking] created ${created.profileId} for ${created.docType} (${created.status})`);
      return 0;
    }

    if (parsed.command === 'record-decision') {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(parsed.decisionPath, 'utf8')) as unknown;
      } catch {
        io.err('[RAG Chunking] the decision file cannot be read or is not JSON');
        return 2;
      }
      const stored = await ops.recordChunkingDecision(raw, options);
      io.out(`[RAG Chunking] recorded the decision on ${stored.profileId} (${stored.docType})`);
      return 0;
    }

    if (parsed.command === 'activate') {
      const result = await ops.activateChunkingProfile(parsed.profileId, { ...options, ...(parsed.docType ? { docType: parsed.docType } : {}), actor: parsed.actor });
      io.out(
        result.changed
          ? `[RAG Chunking] activated ${result.activated} for ${result.docType} (previous: ${result.previous ?? 'none'})`
          : `[RAG Chunking] ${result.activated} was already active for ${result.docType}`,
      );
      await notV2();
      return 0;
    }

    const result = await ops.rollbackChunkingProfile(parsed.docType, { ...options, actor: parsed.actor });
    io.out(`[RAG Chunking] rolled back ${result.docType}: restored ${result.restored}, rolled away from ${result.rolledBack}`);
    await notV2();
    return 0;
  } catch (error) {
    if (error instanceof ops.ChunkingActivationRefused) {
      io.err(`[RAG Chunking] refused: ${error.reason}`);
      if (error.detail !== `chunking_activation_refused:${error.reason}`) io.err(`[RAG Chunking] detail: ${error.detail}`);
      return 3;
    }
    if (error instanceof ops.ChunkingInputError) {
      io.err(`[RAG Chunking] ${error.message}`);
      for (const issue of error.issues) io.err(`[RAG Chunking]   ${issue}`);
      return 2;
    }
    if (error instanceof RetrievalBackendError) {
      io.err(`[RAG Chunking] database error: ${error.rpc}${error.code ? ` (${error.code})` : ''}`);
      return error.code === '22023' ? 2 : 1;
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
      console.error('[RAG Chunking] failed', error instanceof Error ? { error: error.name } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
