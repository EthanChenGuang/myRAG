const placeholders: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key-placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-placeholder',
  OPENAI_API_KEY: 'test-openai-key-placeholder',
  OPENROUTER_API_KEY: 'sk-or-abcdefghijklmnopqrstuvwxyzabcdef',
  EXA_API_KEY: 'test-exa-key-placeholder',
  NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant',
  // D-02: CI, the eval pin and all fixtures run with zh, en and it, primary en.
  RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
  RAG_PRIMARY_LANGUAGE: 'en',
};

for (const [name, value] of Object.entries(placeholders)) {
  process.env[name] = value;
}
