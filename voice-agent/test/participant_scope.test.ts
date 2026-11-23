import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActiveUserGuard, parseScopeToken } from '../src/participant_scope.js';

test('parseScopeToken reads rag_scope_token from JSON metadata', () => {
    assert.equal(parseScopeToken('{"rag_scope_token":"abc"}'), 'abc');
});

test('parseScopeToken ignores other keys', () => {
    assert.equal(parseScopeToken('{"rag_scope_token":"abc","other":1}'), 'abc');
});

test('parseScopeToken returns undefined for missing metadata', () => {
    assert.equal(parseScopeToken(undefined), undefined);
    assert.equal(parseScopeToken(''), undefined);
});

test('parseScopeToken returns undefined for invalid JSON', () => {
    assert.equal(parseScopeToken('not json'), undefined);
    assert.equal(parseScopeToken('{"rag_scope_token":'), undefined);
});

test('parseScopeToken returns undefined when the key is missing or not a non-empty string', () => {
    assert.equal(parseScopeToken('{}'), undefined);
    assert.equal(parseScopeToken('{"rag_scope_token":""}'), undefined);
    assert.equal(parseScopeToken('{"rag_scope_token":42}'), undefined);
    assert.equal(parseScopeToken('null'), undefined);
    assert.equal(parseScopeToken('[]'), undefined);
});

test('ActiveUserGuard lets the first user in and keeps a second user out', () => {
    const guard = new ActiveUserGuard();
    assert.equal(guard.claim('user-a'), true);
    assert.equal(guard.claim('user-b'), false);
    assert.equal(guard.active, 'user-a');
});

test('ActiveUserGuard accepts the active identity again', () => {
    const guard = new ActiveUserGuard();
    assert.equal(guard.claim('user-a'), true);
    assert.equal(guard.claim('user-a'), true);
});

test('ActiveUserGuard frees the slot when the active user is released', () => {
    const guard = new ActiveUserGuard();
    guard.claim('user-a');
    assert.equal(guard.release('user-a'), true);
    assert.equal(guard.active, undefined);
    assert.equal(guard.claim('user-b'), true);
});

test('ActiveUserGuard release by a non-active identity is a no-op', () => {
    const guard = new ActiveUserGuard();
    guard.claim('user-a');
    guard.claim('user-b');
    assert.equal(guard.release('user-b'), false);
    assert.equal(guard.active, 'user-a');
    assert.equal(guard.claim('user-b'), false);
});
