import { z } from 'zod/v3';
import {
  attributeHeaderEnabled,
  getHeaderTemplate,
  listAttributeDefinitions,
  listStaleHeaderDocuments,
  renderPendingHeaders,
  setHeaderTemplate,
  type HeaderTemplateError,
} from '@/lib/rag';
import { admit, invalidRequest, issues, jsonBody, jsonNoStore, notFoundUnless, tenantDataFailure } from '../_tenant-data/lib';

export const runtime = 'nodejs';

const LOG = '[RAG Admin]';
const MAX_TEMPLATE_LENGTH = 200;
const RERENDER_BUDGET_MS = 20_000;
const STALE_PAGE = 200;

const PutSchema = z.object({ template: z.string().min(1).max(MAX_TEMPLATE_LENGTH).nullable() }).strict();
const PostSchema = z.object({ action: z.literal('render') }).strict();

const unavailable = () => jsonNoStore({ success: false, error: 'Tenant rule administration is unavailable' }, 503);

/** unknown_placeholder is a 400 with one detail per name here (the shared mapper answers 409 for the schema route). */
function headerFailure(failure: HeaderTemplateError) {
  if (failure.reason === 'unknown_placeholder') {
    return jsonNoStore(
      { success: false, error: 'unknown_placeholder', details: failure.placeholders.map((name) => ({ path: 'template', message: name })) },
      400,
    );
  }
  return tenantDataFailure(failure);
}

async function rerender(tenantKey: string, signal: AbortSignal): Promise<{ ok: true; rerendered: number; more: boolean } | { ok: false }> {
  const result = await renderPendingHeaders(null, tenantKey, { signal, deadlineMs: RERENDER_BUDGET_MS });
  if (!result.ok) return { ok: false };
  return { ok: true, rerendered: result.rendered, more: result.more };
}

/** The workspace's template, the keys it may name, the length limit and how many documents serve chunks with another stamp. */
export async function GET(request: Request): Promise<Response> {
  const off = notFoundUnless(attributeHeaderEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const input = { actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal };

  const template = await getHeaderTemplate(input);
  if (!template.ok) return headerFailure(template);
  const definitions = await listAttributeDefinitions(input);
  if (!definitions.ok) return tenantDataFailure(definitions);
  const stale = await listStaleHeaderDocuments(admitted.tenantKey, { signal: request.signal, limit: STALE_PAGE });
  if (!stale.ok) return unavailable();
  console.log(`${LOG} attribute header template read`, { version: template.version, stale: stale.items.length });
  return jsonNoStore({
    success: true,
    template: template.template,
    version: template.version,
    placeholders: definitions.items.filter((item) => item.in_header).map((item) => item.key),
    limits: { max_template_length: MAX_TEMPLATE_LENGTH },
    stale: { count: stale.items.length, more: stale.more },
  });
}

/** Saves the template (null removes it), then re-renders the workspace's documents within the budget. */
export async function PUT(request: Request): Promise<Response> {
  const off = notFoundUnless(attributeHeaderEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = PutSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const saved = await setHeaderTemplate(
    { actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal },
    parsed.data.template,
  );
  if (!saved.ok) return headerFailure(saved);
  const rendered = await rerender(admitted.tenantKey, request.signal);
  if (!rendered.ok) return unavailable();
  console.log(`${LOG} attribute header template saved`, { version: saved.version, rerendered: rendered.rerendered, more: rendered.more });
  return jsonNoStore({ success: true, template: saved.template, version: saved.version, rerendered: rendered.rerendered, more: rendered.more });
}

/** `{ action: 'render' }` continues a re-render that a save left with more. */
export async function POST(request: Request): Promise<Response> {
  const off = notFoundUnless(attributeHeaderEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = PostSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const rendered = await rerender(admitted.tenantKey, request.signal);
  if (!rendered.ok) return unavailable();
  console.log(`${LOG} attribute headers re-rendered`, { rerendered: rendered.rerendered, more: rendered.more });
  return jsonNoStore({ success: true, rerendered: rendered.rerendered, more: rendered.more });
}
