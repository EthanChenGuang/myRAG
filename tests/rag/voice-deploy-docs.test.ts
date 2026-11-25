import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const README = fs.readFileSync(path.resolve(__dirname, '../../README_VOICE_INTEGRATION.md'), 'utf8');

describe('README_VOICE_INTEGRATION.md voice deploy contract', () => {
  test('describes per-session rooms, the matching limits and the joint deploy', () => {
    expect(README).toContain('myrag-voice-');
    expect(README).toContain('room metadata');
    expect(README).toContain('VOICE_MAX_ACTIVE_ROOMS');
    expect(README).toContain('VOICE_AGENT_MAX_SESSIONS');
    expect(README).toMatch(/ship together/);
    expect(README).toMatch(/roll back the app and the agent together/i);
  });

  test('no longer describes the pre-per-session model', () => {
    expect(README).not.toContain('participant metadata');
    expect(README).not.toContain('One active user per agent');
    expect(README).not.toMatch(/deploy the voice agent first/i);
  });
});
