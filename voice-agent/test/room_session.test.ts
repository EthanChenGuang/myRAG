import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyParticipant, isVoiceRoomName, parseRoomSession, roomServiceHost, selectNewRooms } from '../src/room_session.js';

const meta = (identity: string, token?: string) => JSON.stringify({ v: 1, participant_identity: identity, ...(token ? { rag_scope_token: token } : {}) });

test('parseRoomSession reads the intended identity and the scope token', () => {
    assert.deepEqual(parseRoomSession(meta('user-a-1', 'tok')), { participantIdentity: 'user-a-1', scopeToken: 'tok' });
});

test('parseRoomSession allows a room without a scope token', () => {
    assert.deepEqual(parseRoomSession(meta('user-anon-1')), { participantIdentity: 'user-anon-1' });
});

test('parseRoomSession rejects missing, malformed or foreign metadata', () => {
    assert.equal(parseRoomSession(undefined), undefined);
    assert.equal(parseRoomSession(''), undefined);
    assert.equal(parseRoomSession('not json'), undefined);
    assert.equal(parseRoomSession('null'), undefined);
    assert.equal(parseRoomSession('[]'), undefined);
    assert.equal(parseRoomSession('{}'), undefined);
    assert.equal(parseRoomSession(JSON.stringify({ participant_identity: 42 })), undefined);
    assert.equal(parseRoomSession(JSON.stringify({ participant_identity: 'voice-agent' })), undefined);
    assert.equal(parseRoomSession(JSON.stringify({ participant_identity: `user-${'a'.repeat(200)}` })), undefined);
});

test('parseRoomSession ignores an empty or non-string scope token', () => {
    assert.deepEqual(parseRoomSession(JSON.stringify({ participant_identity: 'user-a-1', rag_scope_token: '' })), { participantIdentity: 'user-a-1' });
    assert.deepEqual(parseRoomSession(JSON.stringify({ participant_identity: 'user-a-1', rag_scope_token: 5 })), { participantIdentity: 'user-a-1' });
});

test('isVoiceRoomName only accepts per-session voice rooms', () => {
    assert.equal(isVoiceRoomName('myrag-voice-abc'), true);
    assert.equal(isVoiceRoomName('myrag-voice-'), false);
    assert.equal(isVoiceRoomName('myrag-voice'), false);
    assert.equal(isVoiceRoomName('other-room'), false);
});

test('classifyParticipant admits only the intended identity and treats everyone else as an intruder', () => {
    assert.equal(classifyParticipant('user-a-1', 'user-a-1', 'voice-agent'), 'intended');
    assert.equal(classifyParticipant('voice-agent', 'user-a-1', 'voice-agent'), 'agent');
    assert.equal(classifyParticipant('user-b-2', 'user-a-1', 'voice-agent'), 'intruder');
    assert.equal(classifyParticipant('voice-agent-2', 'user-a-1', 'voice-agent'), 'intruder');
});

test('selectNewRooms skips taken rooms, foreign rooms and rooms without valid server metadata', () => {
    const rooms = [
        { name: 'myrag-voice-1', metadata: meta('user-a-1', 't1') },
        { name: 'myrag-voice-2', metadata: meta('user-b-2') },
        { name: 'myrag-voice-3', metadata: '' },
        { name: 'other', metadata: meta('user-c-3') },
        { name: 'myrag-voice-4', metadata: meta('user-d-4') },
    ];
    const picked = selectNewRooms(rooms, new Set(['myrag-voice-2']), 5);
    assert.deepEqual(picked.map((p) => p.name), ['myrag-voice-1', 'myrag-voice-4']);
});

test('selectNewRooms never exceeds the remaining capacity', () => {
    const rooms = ['1', '2', '3'].map((n) => ({ name: `myrag-voice-${n}`, metadata: meta(`user-${n}-x`) }));
    assert.equal(selectNewRooms(rooms, new Set(), 2).length, 2);
    assert.equal(selectNewRooms(rooms, new Set(), 0).length, 0);
});

test('roomServiceHost maps websocket schemes to http', () => {
    assert.equal(roomServiceHost('wss://x.example.test'), 'https://x.example.test');
    assert.equal(roomServiceHost('ws://localhost:7880'), 'http://localhost:7880');
});
