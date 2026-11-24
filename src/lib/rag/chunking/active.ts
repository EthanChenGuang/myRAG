import type { SupabaseClient } from '@supabase/supabase-js';
import { getRagDeps } from '../deps';

export type ActiveChunkingProfiles = Record<string, string>;

const LIST_RPC = 'rag_list_chunking_profiles';
export const CHUNKING_CACHE_TTL_MS = 30_000;

interface Snapshot {
  at: number;
  profiles: ActiveChunkingProfiles | null;
}

let cache: Snapshot | null = null;
let inflight: Promise<ActiveChunkingProfiles | null> | null = null;
let generation = 0;
let testSnapshot: Snapshot | null = null;

const loggedProblems = new Set<string>();

function problem(key: string, message: string, data: Record<string, unknown>): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[RAG Chunking] ${message}`, data);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mapActiveRows(rows: unknown[]): ActiveChunkingProfiles {
  const out: ActiveChunkingProfiles = {};
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row || row.is_active !== true) continue;
    const typeKey = row.doc_type;
    const id = row.id;
    if (typeof typeKey === 'string' && typeof id === 'string') {
      out[typeKey] = id;
    }
  }
  return out;
}

async function readProfiles(admin: SupabaseClient): Promise<ActiveChunkingProfiles | null> {
  const response = await admin.rpc(LIST_RPC, {});
  if (response.error) {
    const code = response.error.code ?? 'unknown';
    problem(`read:${code}`, `chunking_profiles_read_failed code=${code}`, {});
    return null;
  }
  return mapActiveRows(response.data ?? []);
}

function startRead(admin: SupabaseClient): Promise<ActiveChunkingProfiles | null> {
  const startedGeneration = generation;
  const at = getRagDeps().now();
  const run = readProfiles(admin)
    .then((profiles) => {
      const snapshot: Snapshot = { at, profiles };
      if (startedGeneration === generation) cache = snapshot;
      return profiles;
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

function invalidate(): void {
  generation += 1;
  cache = null;
  inflight = null;
  testSnapshot = null;
}

async function snapshot(admin: SupabaseClient): Promise<ActiveChunkingProfiles | null> {
  if (testSnapshot) {
    const age = getRagDeps().now() - testSnapshot.at;
    if (age >= 0 && age < CHUNKING_CACHE_TTL_MS) return testSnapshot.profiles;
  }
  if (cache) {
    const age = getRagDeps().now() - cache.at;
    if (age >= 0 && age < CHUNKING_CACHE_TTL_MS) return cache.profiles;
  }
  return inflight ?? startRead(admin);
}

/** Active chunking profile id per doc type; null when the registry cannot be read. */
export async function getActiveChunkingProfiles(): Promise<ActiveChunkingProfiles | null> {
  if (testSnapshot) {
    const age = getRagDeps().now() - testSnapshot.at;
    if (age >= 0 && age < CHUNKING_CACHE_TTL_MS) return testSnapshot.profiles;
  }
  const admin = getRagDeps().adminClient();
  if (!admin) return null;
  return snapshot(admin);
}

/** Drops the cache and reads the active pointers again. */
export async function refreshActiveChunkingProfiles(): Promise<ActiveChunkingProfiles | null> {
  const admin = getRagDeps().adminClient();
  if (!admin) {
    invalidate();
    return null;
  }
  invalidate();
  return startRead(admin);
}

export function setActiveChunkingProfilesForTests(profiles: ActiveChunkingProfiles | null): void {
  testSnapshot = { at: getRagDeps().now(), profiles };
}

export function resetActiveChunkingProfilesForTests(): void {
  invalidate();
}