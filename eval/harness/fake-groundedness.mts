export interface FakeGroundedness {
  url: string;
  secret: string;
  requests: unknown[];
  close(): Promise<void>;
}

export async function startFakeGroundedness(_options: { secret?: string } = {}): Promise<FakeGroundedness> {
  return { url: 'http://127.0.0.1:9', secret: '', requests: [], close: async () => undefined };
}
