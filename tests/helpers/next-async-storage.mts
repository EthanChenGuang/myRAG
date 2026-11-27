import { AsyncLocalStorage } from 'node:async_hooks';

// Next.js reads a global AsyncLocalStorage when its modules load. Import this module first, before any static import that can reach
// `next/server` (the ingest writer's vector sync kick does), so the global exists by then.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
