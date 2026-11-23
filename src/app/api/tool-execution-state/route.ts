import { NextRequest, NextResponse } from 'next/server';
import { ToolExecutionStateService, PLACEHOLDER_CHAT_ID, type ToolExecutionStatus, type UpdateToolExecutionStateParams } from '@/lib/tool-execution-state';
import { getToolSessionUser, toolApprovalEntryOwner } from '@/lib/tool-execution-auth';

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 });
const STATUSES: ToolExecutionStatus[] = ['pending', 'approved', 'running', 'completed', 'error', 'cancelled'];

/**
 * Transform tool parameters for better compatibility with MCP clients
 * This function applies transformations BEFORE storing in persistent state
 */
function transformToolParameters(toolName: string, originalParams: any): any {
  let optimizedParams = { ...originalParams };

  // 🎯 CRITICAL FIX: Transform instructions → query for Gmail find_email tools
  // The Zapier MCP client expects 'query' parameter, but AI sends 'instructions'
  if (toolName.includes('find_email') && optimizedParams.instructions && !optimizedParams.query) {
    console.log('🔍 [PARAM TRANSFORM] Converting instructions to query parameter for Gmail find_email');
    console.log('🔍 [PARAM TRANSFORM] Original instructions:', optimizedParams.instructions);
    
    // Transform instructions to Gmail search query
    let searchQuery = optimizedParams.instructions;
    
    // Add default search scope if not specified
    if (!searchQuery.includes('in:') && !searchQuery.includes('from:') && !searchQuery.includes('subject:')) {
      // For general queries like "find my recent emails", add in:inbox
      if (searchQuery.toLowerCase().includes('recent') || searchQuery.toLowerCase().includes('latest') || searchQuery.toLowerCase().includes('last')) {
        searchQuery = 'in:inbox';
      }
    }
    
    // 🎯 PARAMETER ORDER FIX: Force explicit property order using Object.defineProperty
    const instructions = optimizedParams.instructions;
    optimizedParams = {};
    
    // Define properties in explicit order
    Object.defineProperty(optimizedParams, 'instructions', {
      value: instructions,
      writable: true,
      enumerable: true,
      configurable: true
    });
    
    Object.defineProperty(optimizedParams, 'query', {
      value: searchQuery,
      writable: true,
      enumerable: true,
      configurable: true
    });
    
    console.log('🔍 [PARAM TRANSFORM] Transformed query:', searchQuery);
    console.log('🔍 [PARAM TRANSFORM] Final parameter count:', Object.keys(optimizedParams).length);
    console.log('🔍 [PARAM TRANSFORM] Parameter order:', Object.keys(optimizedParams));
    console.log('🔍 [PARAM TRANSFORM] Final object JSON:', JSON.stringify(optimizedParams, null, 2));
  }

  return optimizedParams;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getToolSessionUser();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json();
    const { chat_id, message_id, tool_call_id, tool_name, tool_params } = body;

    if (!chat_id || !message_id || !tool_call_id || !tool_name) {
      return NextResponse.json(
        { error: 'Missing required fields: chat_id, message_id, tool_call_id, tool_name' },
        { status: 400 }
      );
    }

    const entry = toolApprovalEntryOwner(String(tool_call_id));
    if (entry.exists && entry.ownerUserId !== auth.userId) return NOT_FOUND();

    const access = await ToolExecutionStateService.getChatAccess(String(chat_id), auth.userId);
    if (access === 'foreign' || (access === 'absent' && !(entry.exists && entry.ownerUserId === auth.userId))) {
      return NOT_FOUND();
    }

    const existing = await ToolExecutionStateService.getByToolCallId(String(tool_call_id));
    if (existing?.user_id && existing.user_id !== auth.userId) return NOT_FOUND();

    console.log('[API] Creating tool execution state:', { chat_id, message_id, tool_call_id, tool_name });
    
    // 🎯 CRITICAL FIX: Apply parameter transformation before creating persistent state
    const transformedParams = transformToolParameters(tool_name, tool_params || {});
    console.log('[API] 🔍 Parameter transformation applied:', {
      original: tool_params,
      transformed: transformedParams,
      originalCount: Object.keys(tool_params || {}).length,
      transformedCount: Object.keys(transformedParams).length
    });

    const state = await ToolExecutionStateService.create({
      chat_id,
      message_id,
      tool_call_id,
      tool_name,
      tool_params: transformedParams,
      user_id: auth.userId
    });

    if (!state) {
      return NextResponse.json(
        { error: 'Failed to create tool execution state' },
        { status: 500 }
      );
    }

    console.log('[API] Successfully created tool execution state:', state.id);
    return NextResponse.json(state);
  } catch (error) {
    console.error('[API] Error creating tool execution state:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getToolSessionUser();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { searchParams } = new URL(req.url);
    const tool_call_id = searchParams.get('tool_call_id');
    const chat_id = searchParams.get('chat_id');
    const message_id = searchParams.get('message_id');

    if (tool_call_id) {
      // Get by tool call ID
      let state = await ToolExecutionStateService.getForUser(tool_call_id, auth.userId);
      
      // 🎯 CRITICAL FIX: If no persistent state exists, check global toolApprovalState
      if (!state) {
        console.log(`[API] No persistent state found for ${tool_call_id}, checking global state...`);
        
        const global = globalThis as any;
        if (global.toolApprovalState && global.toolApprovalState[tool_call_id]?.ownerUserId === auth.userId) {
          const globalToolCall = global.toolApprovalState[tool_call_id].toolCall;
          console.log(`[API] Found global state for ${tool_call_id}:`, globalToolCall);
          
          // Create persistent state from global state
          if (globalToolCall) {
            // 🎯 CRITICAL FIX: Apply parameter transformation before creating persistent state from global state
            const transformedParams = transformToolParameters(globalToolCall.name || 'unknown_tool', globalToolCall.params || {});
            console.log(`[API] 🔍 Global state parameter transformation:`, {
              toolName: globalToolCall.name,
              original: globalToolCall.params,
              transformed: transformedParams,
              originalCount: Object.keys(globalToolCall.params || {}).length,
              transformedCount: Object.keys(transformedParams).length
            });
            
            state = await ToolExecutionStateService.create({
              chat_id: PLACEHOLDER_CHAT_ID,
              message_id: Date.now(),
              tool_call_id: tool_call_id,
              tool_name: globalToolCall.name || 'unknown_tool',
              tool_params: transformedParams,
              user_id: auth.userId
            });
            
            if (state) {
              console.log(`[API] Created persistent state from global state: ${state.id}`);
              console.log(`[API] Stored transformed parameters:`, state.tool_params);
            }
          }
        } else {
          console.log(`[API] No global state found for ${tool_call_id}`);
        }
      }
      
      return NextResponse.json(state);
    } else if (chat_id && message_id) {
      const messageNumber = parseInt(message_id, 10);
      if (Number.isNaN(messageNumber)) {
        return NextResponse.json({ error: 'Invalid message_id' }, { status: 400 });
      }
      if ((await ToolExecutionStateService.getChatAccess(chat_id, auth.userId)) !== 'owned') return NOT_FOUND();
      const states = await ToolExecutionStateService.getByMessageId(chat_id, messageNumber);
      return NextResponse.json(states);
    } else if (chat_id) {
      if ((await ToolExecutionStateService.getChatAccess(chat_id, auth.userId)) !== 'owned') return NOT_FOUND();
      const states = await ToolExecutionStateService.getByChatId(chat_id);
      return NextResponse.json(states);
    } else {
      return NextResponse.json(
        { error: 'Missing required parameter: tool_call_id, chat_id, or message_id' },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error('[API] Error getting tool execution state:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await getToolSessionUser();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json();
    const { tool_call_id } = body ?? {};

    if (!tool_call_id || typeof tool_call_id !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: tool_call_id' },
        { status: 400 }
      );
    }

    const updates: UpdateToolExecutionStateParams = {};
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      updates.status = body.status;
    }
    if (body.tool_result !== undefined) updates.tool_result = body.tool_result;
    if (body.error_message !== undefined) updates.error_message = body.error_message;
    if (body.tool_params !== undefined) updates.tool_params = body.tool_params;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }

    const existing = await ToolExecutionStateService.getForUser(tool_call_id, auth.userId);
    if (!existing) return NOT_FOUND();

    console.log('[API] Updating tool execution state:', { tool_call_id, fields: Object.keys(updates) });

    const state = await ToolExecutionStateService.updateById(existing.id, updates);

    if (!state) {
      return NextResponse.json(
        { error: 'Tool execution state not found or failed to update' },
        { status: 404 }
      );
    }

    console.log('[API] Successfully updated tool execution state');
    return NextResponse.json(state);
  } catch (error) {
    console.error('[API] Error updating tool execution state:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
