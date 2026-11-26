/** D-25: observes a UI message stream and calls `onFirst` once, when the first `text-delta` chunk passes; chunks are never altered. */
export function withFirstTextDelta<T extends { type: string }>(stream: ReadableStream<T>, onFirst: () => void): ReadableStream<T> {
  let seen = false;
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        if (!seen && chunk.type === 'text-delta') {
          seen = true;
          try {
            onFirst();
          } catch {
            // timing must never affect the answer stream
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

// D-26: module state only, so no configuration can slow production requests.
let preGenerationDelayMs = 0;

export function setPreGenerationDelayForTests(ms: number): void {
  preGenerationDelayMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function resetPreGenerationDelayForTests(): void {
  preGenerationDelayMs = 0;
}

/** Waits the delay a test injected before generation starts; resolves at once otherwise. */
export async function awaitPreGenerationDelay(): Promise<void> {
  const delay = preGenerationDelayMs;
  if (delay <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
