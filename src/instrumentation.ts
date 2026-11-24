export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { verifyActiveEmbeddingProfileAtStartup } = await import('@/lib/rag');
      await verifyActiveEmbeddingProfileAtStartup();
    } catch {
      // The check logs its own failures; a broken import must not stop the server from starting.
    }
  }
}
