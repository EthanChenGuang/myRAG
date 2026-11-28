import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isNangoEnabled } from '@/lib/nango/client';
import type { SharePointProvider } from '@/lib/nango/sharepoint/config';
import { GraphDeadlineError, GraphHttpError } from '@/lib/nango/sharepoint/graph';
import { PickerCursorError, isGraphId, listDrives, listFolders, listSites, type PickerConnection, type PickerPage } from '@/lib/nango/sharepoint/picker';
import { requireSessionUser } from '../../_lib/session-user';

/**
 * Shared handler of the three SharePoint / OneDrive picker listing routes (Phase 6.3, D-22). The caller checks the
 * switch first. The connection is always the session user's own connected one for the provider; no connection id is
 * read from the request (T-06.3-32). Responses carry ids, names and an opaque cursor only.
 */
export type PickerKind = 'sites' | 'drives' | 'folders';

const NO_STORE = { 'Cache-Control': 'no-store' };

const graphId = z.string().refine(isGraphId);
const cursor = z.string().min(1).max(4096).optional();
const provider = z.enum(['sharepoint-online', 'one-drive']).default('sharepoint-online');

const sitesQuery = z.object({
    provider: z.literal('sharepoint-online').default('sharepoint-online'),
    query: z.string().max(200).optional(),
    cursor,
});

const drivesQuery = z
    .object({ provider, site_id: graphId.optional(), cursor })
    .refine((value) => (value.provider === 'sharepoint-online' ? value.site_id !== undefined : value.site_id === undefined));

const foldersQuery = z.object({ provider, drive_id: graphId, item_id: graphId.optional(), cursor });

function json(body: unknown, status: number): NextResponse {
    return NextResponse.json(body, { status, headers: NO_STORE });
}

export function pickerNotFound(): NextResponse {
    return json({ error: 'Not found' }, 404);
}

function queryOf(request: NextRequest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) if (!(key in out)) out[key] = value;
    return out;
}

type Planned = { provider: SharePointProvider; run: (connection: PickerConnection) => Promise<PickerPage> };

function plan(kind: PickerKind, query: Record<string, string>): Planned | null {
    if (kind === 'sites') {
        const parsed = sitesQuery.safeParse(query);
        if (!parsed.success) return null;
        const { query: term, cursor: next } = parsed.data;
        return { provider: 'sharepoint-online', run: (connection) => listSites(connection, term ?? '', next ?? null) };
    }
    if (kind === 'drives') {
        const parsed = drivesQuery.safeParse(query);
        if (!parsed.success) return null;
        const { provider: chosen, site_id: siteId, cursor: next } = parsed.data;
        return { provider: chosen, run: (connection) => listDrives(connection, siteId ?? null, next ?? null) };
    }
    const parsed = foldersQuery.safeParse(query);
    if (!parsed.success) return null;
    const { provider: chosen, drive_id: driveId, item_id: itemId, cursor: next } = parsed.data;
    return { provider: chosen, run: (connection) => listFolders(connection, driveId, itemId ?? null, next ?? null) };
}

export async function handlePickerRequest(request: NextRequest, kind: PickerKind): Promise<NextResponse> {
    if (!isNangoEnabled()) return json({ error: 'Nango integration not enabled' }, 503);

    const auth = await requireSessionUser();
    if (!auth.ok) {
        auth.response.headers.set('Cache-Control', 'no-store');
        return auth.response;
    }

    const planned = plan(kind, queryOf(request));
    if (!planned) return json({ error: 'invalid_request' }, 400);

    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return json({ error: 'Server configuration error' }, 500);

    const { data: rows, error } = await supabaseAdmin
        .from('nango_connections')
        .select('connection_id')
        .eq('user_id', auth.user.id)
        .eq('provider', planned.provider)
        .eq('status', 'connected');
    if (error) {
        console.error('[Nango] SharePoint picker connection lookup failed', { kind });
        return json({ error: 'Server error' }, 500);
    }
    const connectionId = (rows as Array<{ connection_id?: unknown }> | null)?.find((row) => typeof row.connection_id === 'string')?.connection_id as string | undefined;
    if (!connectionId) return json({ error: 'No connected account found for this provider' }, 404);

    try {
        const page = await planned.run({ connectionId, provider: planned.provider });
        console.log('[Nango] SharePoint picker listed', { kind, count: page.items.length, more: page.cursor !== null });
        return json({ items: page.items, cursor: page.cursor }, 200);
    } catch (failure) {
        if (failure instanceof PickerCursorError) return json({ error: 'invalid_cursor' }, 400);
        if (failure instanceof GraphDeadlineError || (failure instanceof GraphHttpError && failure.status === 429)) {
            console.warn('[Nango] SharePoint picker throttled', { kind });
            return json({ error: 'throttled' }, 429);
        }
        const word = failure instanceof Error ? failure.name : 'unknown';
        console.error('[Nango] SharePoint picker listing failed', { kind, failure: word, status: failure instanceof GraphHttpError ? failure.status : undefined });
        return json({ error: 'upstream_failed' }, 502);
    }
}
