import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const env = process.env as Record<string, string | undefined>;

describe('embed widget script renders stream error events', () => {
  let savedEnabled: string | undefined;

  beforeEach(() => {
    savedEnabled = env.NEXT_PUBLIC_EMBED_ENABLED;
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEnabled === undefined) delete env.NEXT_PUBLIC_EMBED_ENABLED;
    else env.NEXT_PUBLIC_EMBED_ENABLED = savedEnabled;
    vi.resetModules();
  });

  async function servedScript(): Promise<string> {
    const { GET } = await import('@/app/embed/chat.js/route');
    const response = await GET(new NextRequest('http://localhost/embed/chat.js'));
    expect(response.status).toBe(200);
    return response.text();
  }

  it('serves a script that still compiles', async () => {
    const script = await servedScript();
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('handles type error events in the data branch with the generic message and stops the stream loop', async () => {
    const script = await servedScript();

    const dataBranch = script.indexOf("line.startsWith('data:')");
    const errorBranch = script.indexOf("parsed.type === 'error'");
    const deltaBranch = script.indexOf("eventType === 'text-delta'");
    expect(dataBranch).toBeGreaterThan(-1);
    expect(errorBranch).toBeGreaterThan(dataBranch);
    expect(errorBranch).toBeLessThan(deltaBranch);

    const branchBody = script.slice(errorBranch, deltaBranch);
    expect(branchBody).toContain('removeLoadingDots()');
    expect(branchBody).toContain("'Sorry, I encountered an error. Please try again.'");
    expect(branchBody).toContain('bubble.textContent = genericError');
    expect(branchBody).toContain('return;');
  });

  it('shows the same generic text as the request-failure handler and never echoes the server error text', async () => {
    const script = await servedScript();
    const errorBranch = script.indexOf("parsed.type === 'error'");
    const deltaBranch = script.indexOf("eventType === 'text-delta'");
    const branchBody = script.slice(errorBranch, deltaBranch);

    expect(script).toContain("let errorMessage = 'Sorry, I encountered an error. Please try again.';");
    expect(branchBody).not.toContain('errorText');
    expect(branchBody).not.toContain('parsed.message');
  });
});
