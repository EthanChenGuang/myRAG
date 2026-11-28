import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin, requireAdminOrDeny } from '@/lib/admin-route-auth';
import {
  listRollouts,
  promoteRollout,
  RolloutRefusedError,
  rolloutRpc,
  rolloutServiceDeps,
  rolloutsEnabled,
  RolloutUnavailableError,
  type ActiveRolloutListEntry,
  type EndedRollout,
  type RolloutLanguageRow,
} from '@/lib/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * LANG-11 (plan 07-49): list rollouts and run start, include, exclude, rollback and promote. Operator admins only, fail closed;
 * 404 while RAG_ROLLOUTS is off, before the admin check and any database read. Answers hold ids, keys, counts and refusal codes only:
 * never the salt (rag_rollout_active returns it to the service role), an actor id or any text. A refused promote is 409 { code }.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };
const TENANT_KEY = z.string().regex(/^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, 'Invalid workspace key');
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Invalid id');
const REF = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'Invalid candidate id');

const BodySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      kind: z.enum(['embedding_profile', 'chunking_profile', 'rebuild_run']),
      candidate: z.union([REF, z.array(REF).min(1).max(20)]),
      mode: z.enum(['tenants', 'share']),
      tenants: z.array(TENANT_KEY).min(1).max(500).optional(),
      share: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ action: z.literal('include'), rolloutId: UUID, tenant: TENANT_KEY }).strict(),
  z.object({ action: z.literal('exclude'), rolloutId: UUID, tenant: TENANT_KEY }).strict(),
  z.object({ action: z.literal('rollback'), rolloutId: UUID }).strict(),
  z.object({ action: z.literal('promote'), rolloutId: UUID }).strict(),
]);
type Body = z.infer<typeof BodySchema>;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function fail(status: 400 | 404 | 409 | 503, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return json({ success: false, error, ...extra }, status);
}

function languagesBody(languages: readonly RolloutLanguageRow[]): Array<Record<string, unknown>> {
  return languages.map((language) => ({
    language: language.language,
    measures: language.measures.map((row) => ({
      measure: row.measure,
      candidate: { value: row.candidate.value, n: row.candidate.n },
      before: { value: row.before.value, n: row.before.n },
      others: { value: row.others.value, n: row.others.n },
      verdict: row.verdict,
    })),
  }));
}

function activeBody(entry: ActiveRolloutListEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    candidate: [...entry.candidate],
    incumbent: [...entry.incumbent],
    mode: entry.mode,
    share: entry.share,
    state: entry.state,
    createdAt: entry.createdAt,
    included: [...entry.included],
    excluded: [...entry.excluded],
    arms: { candidate: entry.arms.candidate, incumbent: entry.arms.incumbent },
    languages: languagesBody(entry.languages),
  };
}

function endedBody(entry: EndedRollout): Record<string, unknown> {
  return { id: entry.id, kind: entry.kind, candidate: [...entry.candidate], state: entry.state, endedAt: entry.endedAt };
}

export async function GET(request: Request): Promise<Response> {
  if (!rolloutsEnabled()) return fail(404, 'Not found');
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;
  const deps = rolloutServiceDeps();
  if (!deps) return fail(503, 'Rollouts are unavailable');
  try {
    const list = await listRollouts(deps);
    console.log('[RAG Rollout] list read', { active: list.active.length, ended: list.ended.length });
    return json({
      active: list.active.map(activeBody),
      ended: list.ended.map(endedBody),
      policy: { observationDays: list.policy.observationDays, minSamples: list.policy.minSamples },
    });
  } catch (error) {
    console.error('[RAG Rollout] list failed', { code: error instanceof RolloutUnavailableError || error instanceof RolloutRefusedError ? error.code : 'unknown' });
    return fail(503, 'Rollouts are unavailable');
  }
}

function candidateRef(body: Extract<Body, { action: 'start' }>): Record<string, unknown> | null {
  const ids = Array.isArray(body.candidate) ? body.candidate : body.candidate.split(',').map((id) => id.trim()).filter(Boolean);
  if (body.kind === 'chunking_profile') return { chunking_profile_ids: ids };
  if (ids.length !== 1) return null;
  if (body.kind === 'rebuild_run') return UUID.safeParse(ids[0]).success ? { rebuild_run_id: ids[0] } : null;
  return { embedding_profile_id: ids[0] };
}

/** A SQL refusal: not_found / not_active is 404 (the rollout changed), a malformed key 400, everything else 409 { code }. */
function refused(code: string): NextResponse {
  if (code === 'not_found' || code === 'not_active') return fail(404, 'Not found', { code });
  if (code === 'bad_tenant_key') return fail(400, 'Invalid request data', { details: [{ path: 'tenant', message: 'Invalid workspace key' }] });
  return json({ code }, 409);
}

export async function POST(request: Request): Promise<Response> {
  if (!rolloutsEnabled()) return fail(404, 'Not found');
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, 'Invalid request data', { details: [{ path: '', message: 'Body must be JSON' }] });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail(400, 'Invalid request data', { details: parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  }
  const body = parsed.data;
  if (body.action === 'start') {
    if (body.mode === 'tenants' ? !body.tenants || body.share !== undefined : body.share === undefined || body.tenants !== undefined) {
      return fail(400, 'Invalid request data', { details: [{ path: body.mode === 'tenants' ? 'tenants' : 'share', message: 'Required for this mode' }] });
    }
    if (!candidateRef(body)) return fail(400, 'Invalid request data', { details: [{ path: 'candidate', message: 'Invalid candidate id' }] });
  }

  const deps = rolloutServiceDeps();
  if (!deps) return fail(503, 'Rollouts are unavailable');
  const client = deps.rpc;
  const actor = admin.userId;
  try {
    switch (body.action) {
      case 'start': {
        const id = await rolloutRpc(client, 'rag_rollout_start', {
          p_kind: body.kind,
          p_candidate_ref: candidateRef(body),
          p_mode: body.mode,
          p_share_percent: body.mode === 'share' ? body.share : null,
          p_tenants: body.mode === 'tenants' ? [...new Set(body.tenants)] : null,
          p_actor: actor,
        });
        console.log('[RAG Rollout] started', { kind: body.kind, mode: body.mode });
        return json({ id: typeof id === 'string' ? id : null, kind: body.kind }, 201);
      }
      case 'include':
      case 'exclude': {
        await rolloutRpc(client, 'rag_rollout_set_tenant', { p_rollout_id: body.rolloutId, p_tenant_key: body.tenant, p_membership: body.action, p_actor: actor });
        console.log('[RAG Rollout] membership changed', { rolloutId: body.rolloutId, membership: body.action });
        return json({ id: body.rolloutId, tenant: body.tenant, membership: body.action });
      }
      case 'rollback': {
        await rolloutRpc(client, 'rag_rollout_rollback', { p_rollout_id: body.rolloutId, p_actor: actor });
        console.log('[RAG Rollout] rolled back', { rolloutId: body.rolloutId });
        return json({ id: body.rolloutId, state: 'rolled_back' });
      }
      case 'promote': {
        const result = await promoteRollout(body.rolloutId, actor, deps);
        if (!result.ok) {
          console.log('[RAG Rollout] promotion refused', { rolloutId: body.rolloutId, code: result.code });
          if (result.code === 'rollout_not_active') return fail(404, 'Not found', { code: result.code });
          return json({ code: result.code }, 409);
        }
        return json({
          id: result.rolloutId,
          kind: result.kind,
          candidate: [...result.candidate],
          state: 'promoted',
          arms: { candidate: result.arms.candidate, incumbent: result.arms.incumbent },
          languages: languagesBody(result.languages),
        });
      }
    }
  } catch (error) {
    if (error instanceof RolloutRefusedError) return refused(error.code);
    console.error('[RAG Rollout] action failed', { action: body.action, code: error instanceof RolloutUnavailableError ? error.code : 'unknown' });
    return fail(503, 'Rollouts are unavailable');
  }
}
