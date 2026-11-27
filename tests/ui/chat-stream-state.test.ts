import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const page = readFileSync(path.join(root, 'src/app/page.tsx'), 'utf8');

describe('streaming state after a stream ends', () => {
  const start = page.indexOf('const commitStreamingMessage = () => {');
  const commit = page.slice(start, page.indexOf('\n        };', start));
  const updater = commit.slice(commit.indexOf('setMessages('));

  it('commits the streaming message without setState inside the setMessages updater', () => {
    expect(start).toBeGreaterThan(-1);
    expect(updater).toMatch(/setMessages\(prevMessages => prevMessages\.map\(/);
    // React runs the updater lazily at render, after the end-of-stream setIsStreaming(false);
    // a setIsStreaming(true) in it left the composer stuck on "Stop generating".
    expect(updater).not.toMatch(/setIsStreaming|setStreamingMessage/);
  });

  it('never flips the streaming flag back on from a streaming commit', () => {
    expect(commit).not.toMatch(/setIsStreaming\(true\)/);
  });
});
