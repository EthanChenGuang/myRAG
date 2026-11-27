const NAMES = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;

/** Runs fn with the two language variables unset (D-02 legacy texts), then restores them. */
export async function withLanguagesUnset<T>(fn: () => Promise<T>): Promise<T> {
  const saved = NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of NAMES) delete process.env[name];
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
