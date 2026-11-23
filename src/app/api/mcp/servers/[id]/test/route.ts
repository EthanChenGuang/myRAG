import { NextRequest, NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { redactUrls } from '@/lib/mcp/server-redact';
import { authHeaders, loadCustomServers, type McpServer } from '@/lib/mcp/custom-servers-store';

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

// POST /api/mcp/servers/[id]/test - Test server connection and discover tools (admin only)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    console.error('[MCP Server Test API] server action failed', { id });
    return NextResponse.json({ error: 'Failed to perform server action' }, { status: 500 });
  }
}
