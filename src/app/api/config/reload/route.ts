import { NextRequest, NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import fs from 'fs';
import path from 'path';

/**
 * API endpoint to reload environment variables from .env.local
 * This allows the main app to pick up configuration changes without restart
 */

// Helper function to parse .env file content
function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex > 0) {
        const key = trimmed.substring(0, equalIndex).trim();
        const value = trimmed.substring(equalIndex + 1).trim();
        env[key] = value;
      }
    }
  }
  
  return env;
}

// Helper function to update process.env with new values
function updateProcessEnv(newEnvVars: Record<string, string>): string[] {
  const updatedKeys: string[] = [];
  
  for (const [key, value] of Object.entries(newEnvVars)) {
    // Only update Next.js public environment variables for security
    if (key.startsWith('NEXT_PUBLIC_')) {
      const oldValue = process.env[key];
      process.env[key] = value;
      
      // Track which keys were actually updated
      if (oldValue !== value) {
        updatedKeys.push(key);
      }
    }
  }
  
  return updatedKeys;
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireAdminOrDeny(request);
    if (denied) return denied;

    console.log('🔄 Config Reload: Reloading environment variables from .env.local');
    
    const envPath = path.join(process.cwd(), '.env.local');
    
    if (!fs.existsSync(envPath)) {
      return NextResponse.json(
        { 
          error: '.env.local file not found',
          success: false
        },
        { status: 404 }
      );
    }

    // Read and parse the .env.local file
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const newEnvVars = parseEnvFile(envContent);
    
    // Update process.env with new values (only NEXT_PUBLIC_ vars for security)
    const updatedKeys = updateProcessEnv(newEnvVars);
    
    console.log(`🔄 Config Reload: Updated ${updatedKeys.length} environment variables:`, updatedKeys);
    
    // For model configuration specifically, log the current values
    const modelConfigKeys = ['NEXT_PUBLIC_AI_PROVIDER', 'NEXT_PUBLIC_OPENAI_MODELS', 'NEXT_PUBLIC_OPENROUTER_MODELS'];
    const currentModelConfig: Record<string, string | undefined> = {};
    
    for (const key of modelConfigKeys) {
      currentModelConfig[key] = process.env[key];
    }
    
    console.log('🔄 Config Reload: Current model configuration:', currentModelConfig);
    
    const response = NextResponse.json({
      success: true,
      message: 'Environment variables reloaded successfully',
      updatedKeys,
      modelConfig: currentModelConfig,
      timestamp: new Date().toISOString(),
      // Signal to frontend that models were updated
      modelsUpdated: updatedKeys.some(key => key.includes('_MODELS') || key.includes('_PROVIDER'))
    });
    
    return response;

  } catch (error) {
    console.error('Config Reload: Error reloading environment variables:', error);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return NextResponse.json(
      { 
        success: false,
        error: 'Failed to reload environment variables',
        details: errorMessage
      },
      { status: 500 }
    );
  }
}
