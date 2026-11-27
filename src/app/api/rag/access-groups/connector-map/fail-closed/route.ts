import { z } from 'zod/v3';
import { connectorFailClosedCounts } from '@/lib/rag';
import { requireAccessAdmin } from '../../_auth';
import { failureOf, invalid, ok, serviceDeps } from '../../_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });

/** UI-SPEC 6.8: per connection, the number of documents left with the fallback audience (Connectors card). */
export async function GET(request: Request): Promise<Response> {
  const parsed = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admin = await requireAccessAdmin(request, parsed.success ? (parsed.data.organizationId ?? null) : null, request.signal);
  if (!admin.ok) return admin.response;
  if (!parsed.success) return invalid(parsed.error);

  try {
    const connections = await connectorFailClosedCounts(admin.scope, serviceDeps(request));
    return ok({ connections });
  } catch (error) {
    return failureOf(error);
  }
}
