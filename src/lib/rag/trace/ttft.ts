export function withFirstTextDelta<T extends { type: string }>(stream: ReadableStream<T>, _onFirst: () => void): ReadableStream<T> {
  return stream;
}

export function setPreGenerationDelayForTests(_ms: number): void {}

export function resetPreGenerationDelayForTests(): void {}

export async function awaitPreGenerationDelay(): Promise<void> {}
