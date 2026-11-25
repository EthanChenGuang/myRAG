import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { toPublicServer } from '@/lib/mcp/server-redact';
import { EnvWriteError } from '@/lib/env-file';
import { McpServerSchema, loadCustomServers, saveCustomServers, type McpServer } from '@/lib/mcp/custom-servers-store';

// Built-in servers that mirror current implementation
const BUILTIN_SERVERS: McpServer[] = [
  {
    id: 'zapier',
    name: 'Zapier MCP',
    description: 'Built-in Zapier integration for Gmail, Calendar, and productivity tools',
    endpoint: env.MCP_ZAPIER_ENDPOINT || 'https://zapier-mcp.example.com',
    type: 'http' as const,
    enabled: !!env.MCP_ZAPIER_ENDPOINT,
    settings: {
      timeout: 30000,
      retryAttempts: 3,
      enabledInChat: true,
      enabledInEmbed: false,
      yoloMode: env.NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED === 'true',
    }
  }
].filter(server => server.enabled);

// GET /api/mcp/servers - List all servers (admin only; endpoints and credentials are never returned)
export async function GET(req: NextRequest) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  try {
    const customServers = await loadCustomServers();
    const allServers = [...BUILTIN_SERVERS, ...customServers];

    console.log('[MCP Servers API] listed servers', {
      builtin: BUILTIN_SERVERS.length,
      custom: customServers.length,
    });

    return NextResponse.json({
      servers: allServers.map(toPublicServer),
      builtinCount: BUILTIN_SERVERS.length,
      customCount: customServers.length,
      totalCount: allServers.length,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.error('[MCP Servers API] failed to fetch servers');
    return NextResponse.json({ error: 'Failed to fetch MCP servers' }, { status: 500 });
  }
}

// POST /api/mcp/servers - Add new custom server (admin only)
export async function POST(req: NextRequest) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const serverConfig = McpServerSchema.parse(body);

    const customServers = await loadCustomServers();

    if (customServers.some(s => s.id === serverConfig.id)) {
      return NextResponse.json(
        { error: `Server with ID '${serverConfig.id}' already exists` },
        { status: 409 }
      );
    }

    if (BUILTIN_SERVERS.some(s => s.id === serverConfig.id)) {
      return NextResponse.json(
        { error: `Cannot use built-in server ID '${serverConfig.id}'` },
        { status: 409 }
      );
    }

    const newServer: McpServer = { ...serverConfig };

    await saveCustomServers([...customServers, newServer]);

    console.log('[MCP Servers API] server added', { id: newServer.id });

    return NextResponse.json({
      server: toPublicServer(newServer),
      message: `Server '${newServer.name}' added successfully`,
    }, { status: 201 });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid server configuration', details: error.errors },
        { status: 400 }
      );
    }

    if (error instanceof EnvWriteError && error.reason !== 'io') {
      return NextResponse.json({ error: 'Server configuration cannot be stored' }, { status: 400 });
    }

    console.error('[MCP Servers API] failed to add server');
    return NextResponse.json({ error: 'Failed to add MCP server' }, { status: 500 });
  }
}

// PUT /api/mcp/servers/[id] - Update server (handled by dynamic route)
// DELETE /api/mcp/servers/[id] - Delete server (handled by dynamic route)
// POST /api/mcp/servers/[id]/test - Test server connection (handled by dynamic route)
