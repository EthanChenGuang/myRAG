import crypto from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { mintVoiceToken, resolveTenantScope } from '@/lib/rag';

const VOICE_ROOM = 'myrag-voice';
const USER_IDENTITY_PREFIX = 'user-';

async function sessionUserId(): Promise<string | null> {
    try {
        const { createClient } = await import('@/lib/supabase/server');
        const supabase = await createClient();
        const { data } = await supabase.auth.getUser();
        return data?.user?.id ?? null;
    } catch {
        return null;
    }
}

function roomServiceHost(url: string): string {
    return url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

async function anotherUserInRoom(): Promise<boolean> {
    if (!env.LIVEKIT_URL) return false;
    try {
        const client = new RoomServiceClient(roomServiceHost(env.LIVEKIT_URL), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
        const participants = await client.listParticipants(VOICE_ROOM);
        return participants.some((p) => p.identity.startsWith(USER_IDENTITY_PREFIX));
    } catch (error: unknown) {
        console.warn('[LiveKit Token] participant listing failed, continuing', {
            error: error instanceof Error ? error.message : 'unknown',
        });
        return false;
    }
}

export async function GET(req: NextRequest) {
    try {
        if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
            return NextResponse.json(
                { error: 'LiveKit API key or secret is missing on server' },
                { status: 500 }
            );
        }

        const { searchParams } = new URL(req.url);
        const userId = await sessionUserId();

        const resolved = await resolveTenantScope({
            requestedOrganizationId: searchParams.get('organizationId'),
            getUser: async () => (userId ? { id: userId } : null),
            signal: req.signal,
        });
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.reason }, { status: resolved.status });
        }

        if (await anotherUserInRoom()) {
            return NextResponse.json({ error: 'voice_busy' }, { status: 409 });
        }

        const suffix = crypto.randomUUID().slice(0, 8);
        const identity = `${USER_IDENTITY_PREFIX}${userId ? userId.toLowerCase() : 'anon'}-${suffix}`;

        let metadata: string | undefined;
        if (resolved.scope) {
            const minted = mintVoiceToken({
                scope: resolved.scope,
                secret: env.RAG_VOICE_TOKEN_SECRET,
                ttlSeconds: parseInt(env.RAG_VOICE_TOKEN_TTL_SECONDS || '3600', 10),
            });
            if (minted.ok) {
                metadata = JSON.stringify({ rag_scope_token: minted.token });
            } else {
                console.warn('[RAG Tenant] voice token not issued', { reason: minted.reason });
            }
        }

        const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
            identity,
            ...(metadata ? { metadata } : {}),
        });

        at.addGrant({ roomJoin: true, room: VOICE_ROOM, canUpdateOwnMetadata: false });

        const token = await at.toJwt();

        return NextResponse.json({ token, serverUrl: env.LIVEKIT_URL, identity });
    } catch (error: unknown) {
        console.error('[LiveKit Token] Error generating token:', error instanceof Error ? error.message : 'unknown');
        return NextResponse.json({ error: 'Failed to generate LiveKit token' }, { status: 500 });
    }
}
