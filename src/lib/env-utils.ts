import { writeEnvUpdates } from '@/lib/env-file';

/**
 * Updates a variable in the .env.local file
 * @param key The environment variable key to update
 * @param value The new value for the environment variable
 */
export async function updateEnvFile(key: string, value: string): Promise<void> {
  try {
    writeEnvUpdates({ [key]: value });
    console.log(`Updated ${key} in .env.local`);
  } catch (error) {
    console.error(`Error updating ${key} in .env.local`);
    throw error;
  }
}
