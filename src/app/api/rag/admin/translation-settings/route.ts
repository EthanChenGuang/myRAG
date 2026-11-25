import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminWorkspaceDenied, checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { getTranslationSettings, MAX_TRANSLATION_TARGETS, setTranslationSettings } from '@/lib/rag';
import type { TranslationSettingsError, TranslationSettingsView } from '@/lib/rag';
import { TranslationSettingsSchema } from '@/lib/rag-eval/contracts.generated';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const OrganizationIdSchema = z.string().max(64).nullish();
const LanguageCodeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).max(32);

/** D-31 body: the generated TranslationSettings fields; the subset check against the supported languages follows in the service. */
const BodySchema = z
  .object({
    enabled: TranslationSettingsSchema.shape.enabled.removeDefault(),
    targets: z.array(LanguageCodeSchema).max(MAX_TRANSLATION_TARGETS),
    organizationId: OrganizationIdSchema,
  })
  .strict();

type Details = Array<{ path: string; message: string }>;

function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function invalidRequest(details: Details): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}

function project(settings: TranslationSettingsView) {
  return {
    success: true,
    enabled: settings.enabled,
    targets: settings.targets,
    supportedLanguages: settings.supportedLanguages,
    languagesConfigured: settings.languagesConfigured,
    monolingual: settings.monolingual,
    coverage: settings.coverage,
    stale: settings.stale,
    deploymentSwitch: settings.deploymentSwitch,
    updatedAt: settings.updatedAt,
  };
}

function failure(error: TranslationSettingsError): NextResponse {
  switch (error.reason) {
    case 'target_not_supported':
      return jsonNoStore(error.detail ? { success: false, error: error.reason, reason: error.detail } : { success: false, error: error.reason }, 400);
    case 'languages_not_configured':
      return jsonNoStore({ success: false, error: error.reason }, 503);
    case 'invalid_argument':
      return error.detail === 'enabled_without_targets'
        ? invalidRequest([{ path: 'targets', message: 'Enabled translation needs at least one target language' }])
        : jsonNoStore({ success: false, error: 'Invalid request' }, 400);
    case 'invalid_targets':
      return invalidRequest([{ path: 'targets', message: 'Invalid target languages' }]);
    case 'forbidden':
      return jsonNoStore({ success: false, error: 'Forbidden' }, 403);
    default:
      return jsonNoStore({ success: false, error: 'Translation settings are unavailable' }, 503);
  }
}

/** The workspace's translation targets with per-target coverage, the stale flag and the deployment switch (UI-SPEC 8.1). */
export async function GET(request: Request): Promise<Response> {
  const organizationId = OrganizationIdSchema.safeParse(new URL(request.url).searchParams.get('organizationId'));
  const admitted = await checkAdminOrOrgAdmin(request, organizationId.success ? organizationId.data : null);
  if (!admitted.ok) return adminWorkspaceDenied(admitted);
  const result = await getTranslationSettings({ tenantKey: admitted.tenantKey, signal: request.signal });
  if (!result.ok) return failure(result);
  return jsonNoStore(project(result.settings));
}

/** Saves the enabled flag and the targets for the workspace (D-31). Translates nothing and calls no model (D-29). */
export async function PUT(request: Request): Promise<Response> {
  const queryOrganization = OrganizationIdSchema.safeParse(new URL(request.url).searchParams.get('organizationId'));
  const requested = queryOrganization.success ? queryOrganization.data : null;
  const admitted = await checkAdminOrOrgAdmin(request, requested);
  if (!admitted.ok) return adminWorkspaceDenied(admitted);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  const bodyOrganization = parsed.data.organizationId ?? null;
  if (bodyOrganization !== null && bodyOrganization !== (requested ?? null)) {
    return invalidRequest([{ path: 'organizationId', message: 'Must match the organizationId of the query string' }]);
  }

  const result = await setTranslationSettings({
    actorUserId: admitted.userId,
    tenantKey: admitted.tenantKey,
    enabled: parsed.data.enabled,
    targets: parsed.data.targets,
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  return jsonNoStore(project(result.settings));
}
