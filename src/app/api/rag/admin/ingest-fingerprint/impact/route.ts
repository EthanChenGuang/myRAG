import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { computeFingerprintImpact, isSettingName } from '@/lib/rag';
import { fingerprintUnavailable, invalidRequest, jsonNoStore } from '../_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_KEYS = 200;
const MAX_VALUE_LENGTH = 2048;

/** D-11: the proposed values only; keys are limited to the classified RAG_* settings, values are compared, never executed or echoed. */
const BodySchema = z
  .object({
    proposed: z
      .record(z.string().max(MAX_VALUE_LENGTH))
      .refine((value) => Object.keys(value).length <= MAX_KEYS, { message: `at most ${MAX_KEYS} settings` })
      .refine((value) => Object.keys(value).every(isSettingName), { message: 'unknown setting name' }),
  })
  .strict();

/** POST: how many current ready documents the proposed ingestion-side values would leave on previous settings (aggregates only). */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'body must be JSON' }]);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  try {
    const impact = await computeFingerprintImpact(parsed.data.proposed, { signal: request.signal });
    console.log('[RAG Admin] ingest fingerprint impact', { keys: impact.ingestion_keys.length, total: impact.total_current });
    return jsonNoStore(impact);
  } catch (error) {
    return fingerprintUnavailable('impact', error);
  }
}
