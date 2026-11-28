import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { MECHANISM_COMMANDS, REBUILDABLE_MECHANISMS, RebuildInputError, startRebuild, type StartRebuildResult } from '@/lib/rag';
import { invalidRequest, jsonNoStore, rebuildUnavailable } from '../_responses';
import { rebuildRow } from './_rows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One call stays well inside the 60 s function limit; the run keeps its place and the next start of the same settings continues it. */
const START_DEADLINE_MS = 45_000;

/** The mechanism only: the documents come from the server's fingerprint comparison, never from the request (T-03.2-192). */
const BodySchema = z.object({ mechanism: z.enum(REBUILDABLE_MECHANISMS) }).strict();

function answer(result: StartRebuildResult): Response {
  const base = { success: true, mechanism: result.mechanism, affected: result.affected, without_fingerprint: result.withoutFingerprint };
  switch (result.plan.kind) {
    case 'needs_async':
      return jsonNoStore({ ...base, status: 'needs_async', command: result.plan.command });
    case 'command':
      return jsonNoStore({ ...base, status: 'command', command: commandOf(result.mechanism) });
    case 'nothing':
      return jsonNoStore({ ...base, status: 'nothing' });
    default:
      return jsonNoStore({ ...base, status: result.status, run: result.run ? rebuildRow(result.run) : null, resumed: result.resumed === true, more: result.more === true });
  }
}

/** The command a command mechanism shows, without the tenant keys of the plan's per-tenant commands. */
const COMMANDS: Readonly<Record<StartRebuildResult['mechanism'], string>> = Object.freeze({
  reparse: MECHANISM_COMMANDS.reparse,
  rechunk: MECHANISM_COMMANDS.rechunk,
  relex: 'npm run rag:relex',
  reembed: 'npm run rag:reembed',
  recaption: 'npm run rag:reembed -- --recaption',
  retranslate: 'npm run rag:translate',
});

function commandOf(mechanism: StartRebuildResult['mechanism']): string {
  return COMMANDS[mechanism];
}

/**
 * POST { mechanism }: starts the side-by-side rebuild of the documents the saved settings leave on previous settings (D-11), or returns the
 * open run of the same mechanism and settings. reparse with RAG_INGEST_ASYNC off and the command mechanisms start nothing and answer the
 * count and the command. Answers run counts only: no document id or tenant key.
 */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) return invalidRequest(body.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));

  try {
    const result = await startRebuild({ mechanism: body.data.mechanism, startedBy: admin.userId, deadlineMs: START_DEADLINE_MS }, { signal: request.signal });
    console.log('[RAG Admin] rebuild start', { mechanism: result.mechanism, status: result.status, affected: result.affected, runId: result.run?.id ?? null });
    return answer(result);
  } catch (error) {
    if (request.signal.aborted) return jsonNoStore({ success: false, error: 'start_aborted' }, 499);
    if (error instanceof RebuildInputError) return jsonNoStore({ success: false, error: 'start_refused', reason: error.code }, 409);
    return rebuildUnavailable('start', error);
  }
}
