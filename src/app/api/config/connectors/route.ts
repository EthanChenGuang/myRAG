import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import type { NextRequest } from 'next/server';
import { checkAdmin, requireAdminOrDeny } from '@/lib/admin-route-auth';

interface ConnectorStats {
  connected_users: number;
  last_sync: string | null;
  total_syncs: number;
  failed_syncs: number;
}

interface ConnectorProvider {
  provider: string;
  enabled: boolean;
  show_on_dashboard: boolean;
  button_label: string;
  description: string;
  supported_file_types: string[];
  max_files_per_sync: number;
  stats: ConnectorStats;
}

interface ConnectorConfigResponse {
  view: 'admin' | 'public';
  feature_enabled: boolean;
  show_on_dashboard: boolean;
  providers: ConnectorProvider[];
}

// Initialize Supabase client
function getSupabaseClient() {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

// In-memory store for feature settings (in production, would use a database table)
const featureSettingsStore: Record<string, boolean> = {
  feature_enabled: true,
  show_on_dashboard: true,
};

const SUPPORTED_PROVIDERS = ['google-drive', 'dropbox', 'notion'];

const EMPTY_STATS: ConnectorStats = { connected_users: 0, last_sync: null, total_syncs: 0, failed_syncs: 0 };

// GET /api/config/connectors - Connector configuration. Admins also receive aggregate statistics;
// everyone else gets the public flags the dashboard needs to decide which connectors to show.
export async function GET(request: NextRequest) {
  const isAdmin = (await checkAdmin(request)).ok;

  try {
    const supabase = getSupabaseClient();

    const { data: configs, error: configError } = await supabase
      .from('connector_config')
      .select('*')
      .order('provider', { ascending: true });

    if (configError) throw configError;

    const statsMap: Record<string, ConnectorStats> = {};

    if (isAdmin) {
      const { data: connections, error: connError } = await supabase
        .from('nango_connections')
        .select('provider, last_sync_at, status')
        .order('provider', { ascending: true });

      if (connError) throw connError;

      for (const conn of connections || []) {
        const stats = (statsMap[conn.provider] ||= { ...EMPTY_STATS });
        stats.connected_users += 1;
        if (conn.last_sync_at && new Date(conn.last_sync_at) > new Date(stats.last_sync || 0)) {
          stats.last_sync = conn.last_sync_at;
        }
        if (conn.status === 'error') {
          stats.failed_syncs += 1;
        }
        stats.total_syncs += 1;
      }
    }

    const providers: ConnectorProvider[] = (configs || [])
      .filter((config: any) => SUPPORTED_PROVIDERS.includes(config.provider))
      .map((config: any) => ({
        provider: config.provider,
        enabled: config.enabled,
        show_on_dashboard: config.show_on_dashboard,
        button_label: config.button_label,
        description: config.description,
        supported_file_types: config.supported_file_types || [],
        max_files_per_sync: config.max_files_per_sync || 100,
        stats: statsMap[config.provider] || { ...EMPTY_STATS },
      }));

    const response: ConnectorConfigResponse = {
      view: isAdmin ? 'admin' : 'public',
      feature_enabled: featureSettingsStore.feature_enabled,
      show_on_dashboard: featureSettingsStore.show_on_dashboard,
      providers,
    };

    return Response.json(response, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.error('[Connector Config] failed to fetch connector configuration');
    return Response.json({ error: 'Failed to fetch connector configuration' }, { status: 500 });
  }
}

// PUT /api/config/connectors - Update connector configurations
export async function PUT(request: NextRequest) {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const supabase = getSupabaseClient();

    // Update each provider configuration
    if (body.providers && Array.isArray(body.providers)) {
      for (const provider of body.providers) {
        if (!provider || !SUPPORTED_PROVIDERS.includes(provider.provider)) {
          return Response.json({ error: 'Unsupported connector provider' }, { status: 400 });
        }
        const { error } = await supabase
          .from('connector_config')
          .update({
            enabled: provider.enabled,
            show_on_dashboard: provider.show_on_dashboard,
            button_label: provider.button_label,
            description: provider.description,
            supported_file_types: provider.supported_file_types,
            max_files_per_sync: provider.max_files_per_sync,
            updated_at: new Date().toISOString(),
          })
          .eq('provider', provider.provider);

        if (error) throw error;
      }
    }

    // Update global feature settings if provided
    if (typeof body.feature_enabled !== 'undefined' || typeof body.show_on_dashboard !== 'undefined') {
      if (typeof body.feature_enabled !== 'undefined') {
        featureSettingsStore.feature_enabled = body.feature_enabled;
      }
      if (typeof body.show_on_dashboard !== 'undefined') {
        featureSettingsStore.show_on_dashboard = body.show_on_dashboard;
      }

      console.log('[Connector Config] feature settings updated');
    }

    return Response.json({ success: true, message: 'Connector configuration updated' });
  } catch {
    console.error('[Connector Config] failed to update connector configuration');
    return Response.json({ error: 'Failed to update connector configuration' }, { status: 500 });
  }
}
