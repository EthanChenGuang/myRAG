export const VOICE_ROOM_PREFIX = 'myrag-voice-';
export const USER_IDENTITY_PREFIX = 'user-';
const MAX_IDENTITY_LENGTH = 128;

export interface RoomSession {
    participantIdentity: string;
    scopeToken?: string;
}

export function isVoiceRoomName(name: string): boolean {
    return name.startsWith(VOICE_ROOM_PREFIX) && name.length > VOICE_ROOM_PREFIX.length;
}

/**
 * Room metadata is written server-side by the token route when it creates the room.
 * A room without a valid intended participant is never served.
 */
export function parseRoomSession(metadata?: string): RoomSession | undefined {
    if (!metadata) return undefined;
    try {
        const parsed: unknown = JSON.parse(metadata);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        const record = parsed as Record<string, unknown>;
        const identity = record.participant_identity;
        if (typeof identity !== 'string' || !identity.startsWith(USER_IDENTITY_PREFIX) || identity.length > MAX_IDENTITY_LENGTH) {
            return undefined;
        }
        const token = record.rag_scope_token;
        return {
            participantIdentity: identity,
            ...(typeof token === 'string' && token.length > 0 ? { scopeToken: token } : {}),
        };
    } catch {
        return undefined;
    }
}

export function roomServiceHost(url: string): string {
    return url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

export type ParticipantRole = 'intended' | 'agent' | 'intruder';

export function classifyParticipant(identity: string, intended: string, agentIdentity: string): ParticipantRole {
    if (identity === intended) return 'intended';
    if (identity === agentIdentity) return 'agent';
    return 'intruder';
}

export function selectNewRooms(
    rooms: Array<{ name: string; metadata?: string }>,
    taken: ReadonlySet<string>,
    capacity: number,
): Array<{ name: string; session: RoomSession }> {
    const picked: Array<{ name: string; session: RoomSession }> = [];
    for (const room of rooms) {
        if (picked.length >= capacity) break;
        if (!isVoiceRoomName(room.name) || taken.has(room.name)) continue;
        const session = parseRoomSession(room.metadata);
        if (!session) continue;
        picked.push({ name: room.name, session });
    }
    return picked;
}
