import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeEdge } from '../../eval/harness/fake-edge.mts';
import { prepareInProcessEval } from '../../eval/harness/run-eval.mts';
import { createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');

function edgeAcceptsConnections(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function dbIsOpen(fixture: TwoTenantDatabase): Promise<boolean> {
  try {
    await fixture.db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// A listening fake edge left behind by close() keeps the node:test child alive after its tests pass, which hangs the rag-db gate.
describe('prepareInProcessEval close() releases what it acquired and nothing the caller owns', () => {
  let fixture: TwoTenantDatabase;

  before(async () => {
    fixture = await createTwoTenantDatabase();
  });

  after(async () => {
    await fixture?.db.close().catch(() => undefined);
  });

  test('closes the edge it starts for a caller fixture without one and keeps the caller database open', async () => {
    assert.equal(fixture.edge, undefined);
    const prepared = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'multi-tenant', ingestFixture: fixture });
    try {
      assert.equal(await edgeAcceptsConnections(prepared.edge.url), true);
      await prepared.close();
      assert.equal(await edgeAcceptsConnections(prepared.edge.url), false, 'edge started by prepareInProcessEval is still listening');
      assert.equal(await dbIsOpen(fixture), true, 'caller-owned database was closed');
    } finally {
      await prepared.edge.close();
    }
  });

  test('leaves an edge the caller fixture brought open for the caller to close', async () => {
    const callerEdge = await startFakeEdge({ db: fixture.db });
    try {
      const prepared = await prepareInProcessEval({
        corpusDir: CORPUS_DIR,
        deploymentMode: 'multi-tenant',
        ingestFixture: { ...fixture, edge: callerEdge },
      });
      assert.equal(prepared.edge, callerEdge);
      await prepared.close();
      assert.equal(await edgeAcceptsConnections(callerEdge.url), true, 'caller-owned edge was closed');
      assert.equal(await dbIsOpen(fixture), true, 'caller-owned database was closed');
    } finally {
      await callerEdge.close();
    }
    assert.equal(await edgeAcceptsConnections(callerEdge.url), false);
  });

  test('closes the edge of a fixture it builds itself', async () => {
    const prepared = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'multi-tenant' });
    try {
      assert.equal(await edgeAcceptsConnections(prepared.edge.url), true);
      await prepared.close();
      assert.equal(await edgeAcceptsConnections(prepared.edge.url), false, 'edge of a harness-built fixture is still listening');
    } finally {
      await prepared.edge.close();
    }
  });
});
