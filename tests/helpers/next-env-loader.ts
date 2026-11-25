import { processEnv } from '@next/env';

/** Loads env text through the real @next/env loader (dotenv parse plus dotenv-expand) and returns the resulting values. */
export function loadLikeNext(contents: string): Record<string, string> {
  const snapshot = { ...process.env };
  try {
    const files = [{ path: '.env.local', contents, env: {} as Record<string, string | undefined> }];
    processEnv(files as never, process.cwd(), { info() {}, error() {} } as never, true);
    return { ...(files[0].env as Record<string, string>) };
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in snapshot)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(snapshot)) process.env[name] = value;
  }
}
