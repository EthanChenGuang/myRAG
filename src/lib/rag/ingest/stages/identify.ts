import { assertTenantScope, scopeKey } from '../../tenant/scope';
import { fileSha256 } from '../hash';
import { normalizeFilename } from '../identity';
import { getProcessingProfile, type DocType, type ProcessingProfile } from '../profiles/load';
import {
  INGEST_SOURCES,
  IngestStageError,
  type DocTypeOrigin,
  type StageContext,
  type StageOutcome,
  type StageSpec,
} from '../types';

function resolveProfile(picked: DocType | undefined): { docType: DocType; origin: DocTypeOrigin; profile: ProcessingProfile; invalid: boolean } {
  if (picked !== undefined) {
    try {
      return { docType: picked, origin: 'picked', profile: getProcessingProfile(picked), invalid: false };
    } catch {
      return { docType: 'general', origin: 'fallback', profile: getProcessingProfile('general'), invalid: true };
    }
  }
  return { docType: 'general', origin: 'fallback', profile: getProcessingProfile('general'), invalid: false };
}

async function run(ctx: StageContext): Promise<StageOutcome> {
  const { input } = ctx;
  try {
    assertTenantScope(input.scope);
  } catch {
    console.warn('[Ingest] refused: scope was not minted by the tenant module');
    throw new IngestStageError('identify', 'invalid_scope');
  }
  if (!INGEST_SOURCES.includes(input.source)) throw new IngestStageError('identify', 'invalid_source');
  if (typeof input.sourceKey !== 'string' || input.sourceKey.trim() === '') throw new IngestStageError('identify', 'invalid_source_key');

  const bytes = input.file ?? null;
  const resolved = resolveProfile(input.docType);
  if (resolved.invalid) ctx.warnings.push('doc_type_invalid');

  ctx.identity = {
    tenantKey: scopeKey(input.scope).toLowerCase(),
    filename: normalizeFilename(input.filename),
    fileSha256: fileSha256(bytes ?? Buffer.from(input.text ?? '', 'utf8')),
    docType: resolved.docType,
    docTypeOrigin: resolved.origin,
    profile: resolved.profile,
    bytes,
  };
  return { kind: 'next' };
}

export const identifyStage: StageSpec = { name: 'identify', minMsNeeded: 0, run };
