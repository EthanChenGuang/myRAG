import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { embedText, repairOwnerMembership, resolveTenantScope } from '@/lib/rag';
import { isMultiTenant } from '@/lib/deployment-mode';
import { v4 as uuidv4 } from 'uuid';
import { env } from '@/lib/env';
import OpenAI from 'openai';

// Initialize Supabase admin client
const supabaseAdmin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Initialize OpenAI client for title generation
const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

// Token-based chunking utilities (reuse from process-document)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function createTokenBasedChunks(text: string, maxTokens: number = 600, overlapTokens: number = 100): string[] {
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const paragraphTokens = estimateTokens(paragraph);

    if (currentTokens + paragraphTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n\n'));

      const overlapChunk: string[] = [];
      let overlapTokenCount = 0;
      for (let j = currentChunk.length - 1; j >= 0; j--) {
        const overlapParagraph = currentChunk[j];
        const overlapParagraphTokens = estimateTokens(overlapParagraph);
        if (overlapTokenCount + overlapParagraphTokens <= overlapTokens) {
          overlapChunk.unshift(overlapParagraph);
          overlapTokenCount += overlapParagraphTokens;
        } else {
          break;
        }
      }
      currentChunk = overlapChunk;
      currentTokens = overlapTokenCount;
    }

    currentChunk.push(paragraph);
    currentTokens += paragraphTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n'));
  }

  return chunks;
}

// Generate a title using OpenAI
async function generateTitle(content: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that generates concise, descriptive titles for AI-generated content. The title should be 5-10 words, capturing the main topic or purpose of the content. Do not include quotes or special formatting.'
        },
        {
          role: 'user',
          content: `Generate a concise title for this AI response:\n\n${content.substring(0, 1000)}...`
        }
      ],
      max_tokens: 50,
      temperature: 0.7,
    });

    const title = response.choices[0]?.message?.content?.trim() || 'AI Response';
    return title;
  } catch (error) {
    console.error('[AI to RAG] Title generation failed:', error instanceof Error ? error.message : 'unknown error');
    // Fallback: Extract first sentence or use default
    const firstSentence = content.match(/^[^.!?]+[.!?]/)?.[0]?.trim();
    return firstSentence ? firstSentence.substring(0, 50) + '...' : 'AI Response';
  }
}

// Store document and chunks in Supabase
async function storeAIResponseAsDocument(
  title: string,
  content: string,
  chunks: string[],
  metadata: {
    source: string;
    messageId: string;
    chatId?: string;
    generatedAt: string;
  },
  owner: { userId: string; organizationId?: string | null }
) {
  const documentId = uuidv4();
  const filename = `${title} - ${new Date().toISOString().split('T')[0]}.md`;

  try {
    // Store the document
    const { data: document, error: documentError } = await supabaseAdmin
      .from('documents')
      .insert([{
        id: documentId,
        filename: filename,
        content: content,
        metadata: metadata,
        user_id: owner.userId,
        ...(owner.organizationId !== undefined ? { organization_id: owner.organizationId } : {})
      }])
      .select()
      .single();

    if (documentError) {
      console.error('[AI to RAG] Document insert failed:', documentError.message);
      throw documentError;
    }

    // Process chunks with embeddings
    const BATCH_SIZE = 10;
    let successfulChunks = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);

      try {
        const embeddingResults = await Promise.allSettled(
          batch.map(chunk => embedText(chunk, { signal: new AbortController().signal }))
        );

        const chunkInserts = embeddingResults
          .map((result, index) => {
            if (result.status === 'fulfilled') {
              return {
                id: uuidv4(),
                document_id: documentId,
                content: batch[index],
                embedding: result.value,
                ...(owner.organizationId !== undefined ? { organization_id: owner.organizationId } : {})
              };
            }
            console.error('[AI to RAG] Embedding failed for chunk', { index: i + index });
            return null;
          })
          .filter(Boolean);

        if (chunkInserts.length > 0) {
          const { error: chunkError } = await supabaseAdmin
            .from('document_chunks')
            .insert(chunkInserts);

          if (chunkError) {
            console.error('[AI to RAG] Chunk batch insert failed:', chunkError.message);
          } else {
            successfulChunks += chunkInserts.length;
          }
        }
      } catch (batchError) {
        console.error('[AI to RAG] Chunk batch failed:', batchError instanceof Error ? batchError.message : 'unknown error');
      }
    }

    return {
      documentId,
      filename,
      successfulChunks,
      totalChunks: chunks.length
    };
  } catch (error) {
    throw error;
  }
}

export async function POST(req: Request) {
  try {
    let sessionUserPromise: Promise<{ id: string } | null> | null = null;
    const getSessionUser = () => {
      sessionUserPromise ??= (async () => {
        const { createClient: createSSRClient } = await import('@/lib/supabase/server');
        const sbSSR = await createSSRClient();
        const { data: userRes } = await sbSSR.auth.getUser();
        return userRes?.user?.id ? { id: userRes.user.id } : null;
      })();
      return sessionUserPromise;
    };

    let sessionUser: { id: string } | null;
    try {
      sessionUser = await getSessionUser();
    } catch {
      console.error('[AI to RAG] Session lookup failed');
      return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
    }
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { content, messageId, chatId, userId: bodyUserId, organizationId: bodyOrganizationId } = body;

    if (bodyUserId !== undefined && bodyUserId !== null && bodyUserId !== '') {
      if (typeof bodyUserId !== 'string' || bodyUserId.toLowerCase() !== sessionUser.id.toLowerCase()) {
        console.warn('[AI to RAG] Body user does not match the session user');
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    if (typeof content !== 'string' || !content) {
      return NextResponse.json({ error: 'No content provided' }, { status: 400 });
    }

    await repairOwnerMembership({ requestedOrganizationId: bodyOrganizationId, getUser: getSessionUser });
    const tenant = await resolveTenantScope({
      requestedOrganizationId: typeof bodyOrganizationId === 'string' ? bodyOrganizationId : null,
      getUser: getSessionUser,
      signal: req.signal,
    });
    if (!tenant.ok) {
      const error =
        tenant.status === 403 ? 'Forbidden' : tenant.status === 401 ? 'Unauthorized' : 'Workspace verification unavailable';
      return NextResponse.json({ error }, { status: tenant.status });
    }
    if (!tenant.scope) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const owner = {
      userId: sessionUser.id,
      ...(isMultiTenant() ? { organizationId: tenant.scope.organizationId } : {}),
    };

    console.log('[AI to RAG] Processing AI response', { contentLength: content.length });

    const title = await generateTitle(content);

    const chunks = createTokenBasedChunks(content, 600, 100);

    const metadata = {
      source: 'ai_response',
      messageId: messageId as string,
      chatId: chatId as string | undefined,
      generatedAt: new Date().toISOString(),
    };

    const result = await storeAIResponseAsDocument(title, content, chunks, metadata, owner);
    console.log('[AI to RAG] Stored AI response as document', {
      documentId: result.documentId,
      chunksStored: result.successfulChunks,
      totalChunks: result.totalChunks,
    });

    return NextResponse.json({
      success: true,
      documentId: result.documentId,
      filename: result.filename,
      title,
      chunksStored: result.successfulChunks,
      totalChunks: result.totalChunks
    });

  } catch (error) {
    console.error('[AI to RAG] Request failed:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
