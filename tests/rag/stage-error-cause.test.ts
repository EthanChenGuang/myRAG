import { describe, expect, it } from 'vitest';
import { describeStageCause } from '@/lib/rag/stage-error-cause';

describe('describeStageCause', () => {
  it('keeps the class name, status and provider code of an API error', () => {
    class AuthenticationError extends Error {
      status = 401;
      code = 'invalid_api_key';
      constructor() {
        super('Incorrect API key provided: sk-placeholder****1234');
        this.name = 'AuthenticationError';
      }
    }
    expect(describeStageCause(new AuthenticationError())).toEqual({ cause: 'AuthenticationError', status: 401, code: 'invalid_api_key' });
  });

  it('never includes the message', () => {
    const out = describeStageCause(Object.assign(new Error('secret sk-placeholder text'), { status: 429, code: 'insufficient_quota' }));
    expect(JSON.stringify(out)).not.toContain('sk-placeholder');
    expect(out).toEqual({ cause: 'Error', status: 429, code: 'insufficient_quota' });
  });

  it('falls back to the type field and drops unsafe codes', () => {
    expect(describeStageCause({ name: 'APIError', status: 500, type: 'server_error' })).toEqual({ cause: 'APIError', status: 500, code: 'server_error' });
    expect(describeStageCause({ name: 'APIError', code: 'has spaces and sk-x' })).toEqual({ cause: 'APIError' });
  });

  it('handles non-objects', () => {
    expect(describeStageCause(undefined)).toEqual({ cause: 'unknown' });
    expect(describeStageCause('boom')).toEqual({ cause: 'string' });
  });
});
