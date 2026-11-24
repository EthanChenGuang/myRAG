import crypto from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { defaultVoiceTtlSeconds, mintVoiceToken, repairOwnerMembership, resolveTenantScope } from '@/lib/rag';

const VOICE_ROOM_PREFIX = 'myrag-voice-';
const USER_IDENTITY_PREFIX = 'user-';
const DEFAULT_MAX_ACTIVE_VOICE_ROOMS = 4;
const JOIN_TOKEN_TTL_SECONDS = 600;
const ROOM_EMPTY_TIMEOUT_SECONDS = 60;
const ROOM_DEPARTURE_TIMEOUT_SECONDS = 20;
const ROOM_MAX_PARTICIPANTS = 2;

function maxActiveVoiceRooms(): number {
    const parsed = Number.parseInt(env.VOICE_MAX_ACTIVE_ROOMS ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_ACTIVE_VOICE_ROOMS;
}

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

function unavailable(error: string) {
    return NextResponse.json({ error }, { status: 503 });
}

export async function GET(req: NextRequest) {
    try {
        if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
            return NextResponse.json(
                { error: 'LiveKit API key or secret is missing on server' },
                { status: 500 }
            );
        }
        if (!env.LIVEKIT_URL) {
            return NextResponse.json({ error: 'LiveKit URL is missing on server' }, { status: 500 });
        }

        const { searchParams } = new URL(req.url);
        const requestedOrganizationId = searchParams.get('organizationId');
        const userId = await sessionUserId();
        const getUser = async () => (userId ? { id: userId } : null);

        await repairOwnerMembership({ requestedOrganizationId, getUser });
        const resolved = await resolveTenantScope({
            requestedOrganizationId,
            getUser,
            signal: req.signal,
        });
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.reason }, { status: resolved.status });
        }

        let scopeToken: string | undefined;
        if (resolved.scope) {
            const minted = mintVoiceToken({
                scope: resolved.scope,
                secret: env.RAG_VOICE_TOKEN_SECRET,
                ttlSeconds: defaultVoiceTtlSeconds(),
                actorUserId: resolved.scope.kind === 'single' ? userId : null,
            });
            if (!minted.ok) {
                console.error('[RAG Tenant] voice token not issued', { reason: minted.reason });
                return unavailable('voice_unavailable');
            }
            scopeToken = minted.token;
        }

        const suffix = crypto.randomUUID().slice(0, 8);
        const identity = `${USER_IDENTITY_PREFIX}${userId ? userId.toLowerCase() : 'anon'}-${suffix}`;
        const roomName = `${VOICE_ROOM_PREFIX}${crypto.randomBytes(16).toString('hex')}`;

        const roomService = new RoomServiceClient(roomServiceHost(env.LIVEKIT_URL), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
        try {
            const rooms = await roomService.listRooms();
            const active = rooms.filter((room) => room.name.startsWith(VOICE_ROOM_PREFIX)).length;
            if (active >= maxActiveVoiceRooms()) {
                return NextResponse.json({ error: 'voice_busy' }, { status: 409 });
            }
            await roomService.createRoom({
                name: roomName,
                emptyTimeout: ROOM_EMPTY_TIMEOUT_SECONDS,
                departureTimeout: ROOM_DEPARTURE_TIMEOUT_SECONDS,
                maxParticipants: ROOM_MAX_PARTICIPANTS,
                metadata: JSON.stringify({
                    v: 1,
                    participant_identity: identity,
                    ...(scopeToken ? { rag_scope_token: scopeToken } : {}),
                }),
            });
        } catch (error: unknown) {
            console.error('[LiveKit Token] voice room setup failed', {
                error: error instanceof Error ? error.message : 'unknown',
            });
            return unavailable('voice_unavailable');
        }

        const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
            identity,
            ttl: JOIN_TOKEN_TTL_SECONDS,
        });

        at.addGrant({ roomJoin: true, room: roomName, canUpdateOwnMetadata: false });

        const token = await at.toJwt();

        return NextResponse.json({ token, serverUrl: env.LIVEKIT_URL, identity });
    } catch (error: unknown) {
        console.error('[LiveKit Token] Error generating token:', error instanceof Error ? error.message : 'unknown');
        return NextResponse.json({ error: 'Failed to generate LiveKit token' }, { status: 500 });
    }
}
