import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { redactUrls, toPublicServer } from '@/lib/mcp/server-redact';
import { EnvWriteError } from '@/lib/env-file';
import {
  McpServerSchema,
  authHeaders,
  loadCustomServers,
  mergeWithStored,
  saveCustomServers,
  type McpServer,
} from '@/lib/mcp/custom-servers-store';

async function testServerConnection(server: McpServer): Promise<{ success: boolean; message: string; latency?: number }> {
  try {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), server.settings?.timeout || 30000);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    Object.assign(headers, authHeaders(server));
    
    const response = await fetch(server.endpoint, {
      method: 'HEAD',
      headers,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;
    
    if (response.ok || response.status < 500) {
      return {
        success: true,
        message: `Connection successful (${response.status})`,
        latency,
      };
    } else {
      return {
        success: false,
        message: `Server error: ${response.status} ${response.statusText}`,
        latency,
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: error.name === 'AbortError' ? 'Connection timeout' : `Connection failed: ${redactUrls(String(error.message))}`,
    };
  }
}

async function discoverTools(server: McpServer): Promise<{ success: boolean; tools?: any[]; message: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), server.settings?.timeout || 30000);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    Object.assign(headers, authHeaders(server));
    
    // Try common MCP tool discovery endpoints
    const discoveryEndpoints = [
      '/tools',
      '/discover',
      '/capabilities',
      '',
    ];
    
    for (const endpoint of discoveryEndpoints) {
      try {
        const url = server.endpoint + endpoint;
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        
        if (response.ok) {
          const data = await response.json();
          clearTimeout(timeoutId);
          
          // Try to extract tools from various response formats
          let tools = [];
          if (data.tools) {
            tools = Array.isArray(data.tools) ? data.tools : [data.tools];
          } else if (Array.isArray(data)) {
            tools = data;
          } else if (data.capabilities) {
            tools = Array.isArray(data.capabilities) ? data.capabilities : [data.capabilities];
          }
          
          return {
            success: true,
            tools,
            message: `Discovered ${tools.length} tools`,
          };
        }
      } catch (endpointError) {
        // Continue to next endpoint
        continue;
      }
    }
    
    clearTimeout(timeoutId);
    return {
      success: false,
      message: 'No discoverable tools endpoint found. The server may need manual tool configuration.',
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.name === 'AbortError' ? 'Tool discovery timeout' : `Tool discovery failed: ${redactUrls(String(error.message))}`,
    };
  }
}

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/mcp/servers/[id] - Get specific server (admin only; endpoint and credentials are never returned)
export async function GET(req: NextRequest, { params }: RouteContext) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    const customServers = await loadCustomServers();
    const server = customServers.find(s => s.id === id);

    if (!server) {
      return NextResponse.json(
        { error: `Server with ID '${id}' not found` },
        { status: 404 }
      );
    }

    return NextResponse.json({ server: toPublicServer(server) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.error('[MCP Server API] failed to fetch server', { id });
    return NextResponse.json({ error: 'Failed to fetch MCP server' }, { status: 500 });
  }
}

// PUT /api/mcp/servers/[id] - Update server (admin only)
export async function PUT(req: NextRequest, { params }: RouteContext) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const customServers = await loadCustomServers();
    const serverIndex = customServers.findIndex(s => s.id === id);

    if (serverIndex === -1) {
      return NextResponse.json(
        { error: `Server with ID '${id}' not found` },
        { status: 404 }
      );
    }

    const serverConfig = McpServerSchema.parse(mergeWithStored(body, customServers[serverIndex]));

    if (serverConfig.id !== id) {
      return NextResponse.json(
        { error: 'Server ID in URL does not match server ID in body' },
        { status: 400 }
      );
    }

    customServers[serverIndex] = serverConfig;
    await saveCustomServers(customServers);

    console.log('[MCP Server API] server updated', { id });

    return NextResponse.json({
      server: toPublicServer(serverConfig),
      message: `Server '${serverConfig.name}' updated successfully`,
    });
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

    console.error('[MCP Server API] failed to update server', { id });
    return NextResponse.json({ error: 'Failed to update MCP server' }, { status: 500 });
  }
}

// DELETE /api/mcp/servers/[id] - Delete server (admin only)
export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    if (id === 'zapier') {
      return NextResponse.json(
        { error: 'Built-in servers cannot be deleted' },
        { status: 400 }
      );
    }

    const customServers = await loadCustomServers();
    const serverIndex = customServers.findIndex(s => s.id === id);

    if (serverIndex === -1) {
      return NextResponse.json(
        { error: `Server with ID '${id}' not found` },
        { status: 404 }
      );
    }

    const deletedServer = customServers.splice(serverIndex, 1)[0];
    await saveCustomServers(customServers);

    console.log('[MCP Server API] server deleted', { id });

    return NextResponse.json({
      message: `Server '${deletedServer.name}' deleted successfully`,
    });
  } catch {
    console.error('[MCP Server API] failed to delete server', { id });
    return NextResponse.json({ error: 'Failed to delete MCP server' }, { status: 500 });
  }
}

// POST /api/mcp/servers/[id] - Test connection or discover tools for a stored server (admin only)
export async function POST(req: NextRequest, { params }: RouteContext) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const action = body?.action;

    const customServers = await loadCustomServers();
    const server = customServers.find(s => s.id === id);

    if (!server) {
      return NextResponse.json(
        { error: `Server with ID '${id}' not found` },
        { status: 404 }
      );
    }

    if (action === 'test') {
      return NextResponse.json(await testServerConnection(server));
    } else if (action === 'discover') {
      return NextResponse.json(await discoverTools(server));
    } else {
      return NextResponse.json(
        { error: 'Invalid action. Supported actions: test, discover' },
        { status: 400 }
      );
    }
  } catch {
    console.error('[MCP Server API] server action failed', { id });
    return NextResponse.json({ error: 'Failed to perform server action' }, { status: 500 });
  }
}
