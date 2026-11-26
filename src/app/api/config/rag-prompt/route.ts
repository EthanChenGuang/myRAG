import { NextRequest, NextResponse } from 'next/server';
import { checkAdmin, requireAdminOrDeny } from '@/lib/admin-route-auth';
import { EnvWriteError, invalidEnvValueReason, readEnvFile, writeEnvUpdates } from '@/lib/env-file';
import { guardAppEnvWrite } from '@/lib/rag';

/**
 * API endpoint for RAG system prompt configuration
 * Handles the split interface: pre-context + post-context sections
 */

// Helper function to safely decode URL-encoded text
function safeDecodeURIComponent(text: string): string {
  if (!text) return '';

  let decoded = text;
  let previousDecoded = '';

  // Keep decoding until we stop getting changes (handles multiple encoding)
  while (decoded !== previousDecoded) {
    previousDecoded = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch (e) {
      console.warn('Decoding failed, stopping at:', decoded);
      break;
    }
  }

  return decoded;
}

// Helper function to split existing RAG_SYSTEM_PROMPT into pre/post context
function splitExistingPrompt(ragSystemPrompt: string): { preContext: string; postContext: string } {
  if (!ragSystemPrompt) {
    return { preContext: '', postContext: '' };
  }

  // Look for {{context}} placeholder
  const contextIndex = ragSystemPrompt.indexOf('{{context}}');

  if (contextIndex === -1) {
    // No {{context}} found, treat entire prompt as pre-context
    return { preContext: ragSystemPrompt, postContext: '' };
  }

  // Split around {{context}}
  const preContext = ragSystemPrompt.substring(0, contextIndex).trim();
  const postContext = ragSystemPrompt.substring(contextIndex + '{{context}}'.length).trim();

  return { preContext, postContext };
}

// Helper function to assemble complete prompt from pre/post context
function assemblePrompt(preContext: string, postContext: string): string {
  const parts = [];

  if (preContext.trim()) {
    parts.push(preContext.trim());
  }

  parts.push('{{context}}');

  if (postContext.trim()) {
    parts.push(postContext.trim());
  }

  // Join with actual newlines, then escape them for .env.local format
  const assembled = parts.join('\n\n');
  return assembled.replace(/\n/g, '\\n');
}

function escapeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
}

export async function GET(request: NextRequest) {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const env = readEnvFile();

    // First, try to get from RAG_PRE_CONTEXT and RAG_POST_CONTEXT
    let preContext = '';
    let postContext = '';

    if (env.RAG_PRE_CONTEXT) {
      preContext = safeDecodeURIComponent(env.RAG_PRE_CONTEXT);
      // Convert escaped newlines back to actual newlines for display
      preContext = preContext.replace(/\\n/g, '\n');
    }

    if (env.RAG_POST_CONTEXT) {
      postContext = safeDecodeURIComponent(env.RAG_POST_CONTEXT);
      // Convert escaped newlines back to actual newlines for display
      postContext = postContext.replace(/\\n/g, '\n');
    }

    // If both are empty, try to parse from existing RAG_SYSTEM_PROMPT
    if (!preContext && !postContext && env.RAG_SYSTEM_PROMPT) {
      let decodedPrompt = safeDecodeURIComponent(env.RAG_SYSTEM_PROMPT);
      // Convert escaped newlines back to actual newlines
      decodedPrompt = decodedPrompt.replace(/\\n/g, '\n');
      const split = splitExistingPrompt(decodedPrompt);
      preContext = split.preContext;
      postContext = split.postContext;
    }

    // Assemble the complete prompt for preview
    const assembledPrompt = assemblePrompt(preContext, postContext);

    return NextResponse.json({
      success: true,
      preContext,
      postContext,
      assembledPrompt,
      warning: (!preContext && !postContext) ? 'No system prompt configuration found' : undefined
    });
  } catch (error) {
    console.error('Error getting RAG prompt configuration:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get RAG prompt configuration',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function adminUserId(request: Request): Promise<string | null> {
  const admin = await checkAdmin(request);
  return admin.ok ? admin.userId : null;
}

export async function POST(request: NextRequest) {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const body = await request.json();
    const { preContext, postContext, ragGate } = body;

    if (!preContext || typeof preContext !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Pre-context instructions are required' },
        { status: 400 }
      );
    }

    if (postContext && typeof postContext !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Post-context must be a string' },
        { status: 400 }
      );
    }

    // Prepare updates for .env.local
    const updates: Record<string, string> = {};

    // Save individual sections with escaped newlines for .env.local format
    // The system assembles the prompt as: PRE_CONTEXT + {{context}} + POST_CONTEXT
    updates.RAG_PRE_CONTEXT = escapeNewlines(preContext);
    if (postContext) {
      updates.RAG_POST_CONTEXT = escapeNewlines(postContext);
    }

    const invalid = Object.entries(updates)
      .filter(([, value]) => invalidEnvValueReason(value) !== null)
      .map(([name]) => name);
    if (invalid.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Prompt text contains characters that cannot be stored', invalid },
        { status: 400 }
      );
    }

    // Assemble prompt for response (not saved to env file)
    const assembledPrompt = assemblePrompt(preContext, postContext || '');

    const gate = await guardAppEnvWrite({ updates, ragGate, actorUserId: () => adminUserId(request), route: 'rag-prompt' });
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status, headers: { 'Cache-Control': 'no-store' } });

    writeEnvUpdates(updates);

    return NextResponse.json({
      success: true,
      message: 'RAG prompt configuration saved successfully',
      preContext,
      postContext: postContext || '',
      assembledPrompt,
      ...(gate.ragGate ? { ragGate: gate.ragGate } : {})
    });
  } catch (error) {
    console.error('[RAG Prompt API] failed to save RAG prompt configuration');
    if (error instanceof EnvWriteError && error.reason !== 'io') {
      return NextResponse.json(
        { success: false, error: 'Prompt text cannot be stored in .env.local' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { success: false, error: 'Failed to save RAG prompt configuration' },
      { status: 500 }
    );
  }
}
