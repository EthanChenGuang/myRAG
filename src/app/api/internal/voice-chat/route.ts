import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import { resolveVoiceScope } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';
import { generateTitle, generateSmartTitle } from '@/lib/title-generator';
import type { DBMessage } from '@/types/chat';
import { v4 as uuidv4 } from 'uuid';

export const runtime = 'nodejs';

const messageSchema = z.object({ role: z.string() }).passthrough();

/**
 * Internal API Endpoint for Voice Agent to Save Chats
 *
 * Called by the voice agent when a voice session ends.
 * Creates a new chat entry with the voice conversation under the tenant named by the signed scope token.
 */
export async function POST(req: NextRequest) {
    try {
        // Security Check
        const apiKey = req.headers.get('x-api-key');

        if (!env.MYRAG_INTERNAL_API_KEY) {
            console.error('[Voice Chat API] MYRAG_INTERNAL_API_KEY not configured');
            return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
        }

        if (apiKey !== env.MYRAG_INTERNAL_API_KEY) {
            console.warn('[Voice Chat API] Unauthorized access attempt');
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const scope = await resolveVoiceScope({ headers: req.headers, signal: req.signal });
        if (!scope.ok) {
            return NextResponse.json({ error: scope.status === 503 ? 'Voice scope unavailable' : 'Unauthorized', reason: scope.reason }, { status: scope.status });
        }

        // Parse Body
        let body: { messages?: unknown };
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }

        // Identity comes from the verified token only; body userId and organizationId are ignored.
        const userId = scope.actorUserId;
        const organizationId = scope.scope.organizationId;

        if (!userId) {
            return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
        }

        const parsedMessages = z.array(messageSchema).min(1).safeParse(body?.messages);
        if (!parsedMessages.success) {
            return NextResponse.json({ error: 'Missing or invalid messages' }, { status: 400 });
        }
        const messages = parsedMessages.data;
        const titleMessages = messages as unknown as DBMessage[];

        // Require at least one exchange (user + assistant message)
        const hasUserMessage = messages.some((m) => m.role === 'user');
        const hasAssistantMessage = messages.some((m) => m.role === 'assistant');

        if (!hasUserMessage || !hasAssistantMessage) {
            return NextResponse.json({
                error: 'Conversation must have at least one user and one assistant message'
            }, { status: 400 });
        }

        const adminClient = getSupabaseAdmin();
        if (!adminClient) {
            throw new Error('Supabase Admin client unavailable');
        }

        // Generate title from messages
        const title = generateTitle(titleMessages);
        console.log(`[Voice Chat API] Generated title: "${title}"`);

        // Create chat entry
        const chatId = uuidv4();
        const now = new Date().toISOString();

        const { data, error } = await adminClient
            .from('chats')
            .insert({
                id: chatId,
                user_id: userId,
                title,
                messages,
                organization_id: organizationId,
                created_at: now,
                updated_at: now
            })
            .select()
            .single();

        if (error) {
            console.error('[Voice Chat API] Error creating chat:', error);
            throw error;
        }

        console.log(`[Voice Chat API] Created voice chat: ${data.id} with title "${data.title}"`);

        // Async smart title generation (fire and forget)
        generateSmartTitle(titleMessages).then(async (smartTitle) => {
            if (smartTitle && smartTitle !== title && smartTitle !== 'New Chat') {
                console.log(`[Voice Chat API] Updating to smart title: "${smartTitle}"`);
                await adminClient
                    .from('chats')
                    .update({ title: smartTitle })
                    .eq('id', chatId);
            }
        }).catch((err) => {
            console.error('[Voice Chat API] Error generating smart title:', err);
        });

        return NextResponse.json({
            chatId: data.id,
            title: data.title,
            success: true
        });

    } catch (error: unknown) {
        console.error('[Voice Chat API] Error:', error);
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
    }
}
