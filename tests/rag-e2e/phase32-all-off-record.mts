import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compactSnapshot, currentInputs, probeWritePaths } from './phase32-all-off-probe.mts';

// Plan 03.2-66: records the all-off reference. Run it on the pre-phase tree (a worktree at the commit before the first Phase 3.2 commit,
// with this file and phase32-all-off-probe.mts copied in): node --import tsx tests/rag-e2e/phase32-all-off-record.mts <out.json>
const out = process.argv[2];
if (!out) {
  console.error('usage: phase32-all-off-record.mts <out.json>');
  process.exit(2);
}

const inputs = await currentInputs();
const snapshot = compactSnapshot(await probeWritePaths(inputs));
const recordedFrom = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(path.resolve(out), `${JSON.stringify({ recorded_from: recordedFrom, inputs, snapshot })}\n`);
console.log('[Phase 3.2 All-off] reference written', {
  out,
  documents: snapshot.paths.inline.documents.rows.length,
  chunks: snapshot.paths.inline.document_chunks.rows.length,
  queries: inputs.queries.length,
});
process.exit(0);
