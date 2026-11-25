import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { EnvWriteError, readEnvFile, stringifyJsonForEnv, writeEnvUpdates } from '@/lib/env-file';

export interface ModelWithReasoning {
  id: string;
  displayName: string;
  isFree?: boolean;
  isOpenSource?: boolean;
  // Reasoning capabilities
  supportsReasoning?: boolean;
  reasoningMethod?: 'effort' | 'max_tokens' | 'both' | 'none';
  maxTokensLimit?: number;
  minTokens?: number;
  defaultEffort?: 'high' | 'medium' | 'low';
  contextLength?: number;
  description?: string;
}

export interface ModelConfig {
  provider: 'openai' | 'openrouter' | 'groq';
  openaiModels: Array<ModelWithReasoning>;
  openrouterModels: Array<ModelWithReasoning>;
  groqModels: Array<ModelWithReasoning>;
}

async function saveModelConfig(provider: string, openaiModels: any[], openrouterModels: any[], groqModels: any[]): Promise<void> {
  try {
    writeEnvUpdates({
      NEXT_PUBLIC_AI_PROVIDER: provider,
      NEXT_PUBLIC_OPENAI_MODELS: stringifyJsonForEnv(openaiModels),
      NEXT_PUBLIC_OPENROUTER_MODELS: stringifyJsonForEnv(openrouterModels),
      NEXT_PUBLIC_GROQ_MODELS: stringifyJsonForEnv(groqModels),
    });
  } catch (error) {
    if (error instanceof EnvWriteError && error.reason !== 'io') throw error;
    console.error('[Config Models] failed to save model configuration');
    throw new Error('Failed to save model configuration to .env.local');
  }
}

// Safe JSON parsing helper
function safeJsonParse(value: string | undefined, fallback: any[] = []): any[] {
  if (!value) return fallback;

  try {
    // Handle case where value might already be an object/array
    if (typeof value === 'object') {
      return Array.isArray(value) ? value : fallback;
    }

    // Try to parse as JSON string
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    console.warn('Failed to parse JSON value:', value, error);
    return fallback;
  }
}

export async function GET(request: NextRequest) {
  try {
    // Skip admin authorization for config UI access
    // The config UI itself requires admin access, so we can trust requests from it

    // Default fallback models
    const defaultOpenAIModels = [
      { id: 'gpt-4-turbo-preview', displayName: 'GPT-4 Turbo' },
      { id: 'gpt-4', displayName: 'GPT-4' },
      { id: 'gpt-3.5-turbo', displayName: 'GPT-3.5 Turbo' }
    ];

    const defaultOpenRouterModels = [
      { id: 'openai/gpt-4.1-mini', displayName: 'GPT-4.1 Mini' },
      { id: 'openai/gpt-4.1', displayName: 'GPT-4.1' },
      { id: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5' },
      { id: 'anthropic/claude-opus-4.1', displayName: 'Claude Opus 4.1' },
      { id: 'google/gemini-2.5-pro-preview', displayName: 'Gemini 2.5 Pro' },
      { id: 'deepseek/deepseek-chat-v3-0324:free', displayName: 'DeepSeek Chat V3', isFree: true }
    ];

    const defaultGroqModels = [
      { id: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B Versatile' },
      { id: 'openai/gpt-oss-120b', displayName: 'GPT-OSS 120B' },
      { id: 'groq/compound', displayName: 'Groq Compound' },
      { id: 'moonshotai/kimi-k2-instruct-0905', displayName: 'Kimi K2 Instruct' },
    ];

    // Read directly from .env.local file for real-time updates
    const envVars = readEnvFile();

    // Use values from file if available, otherwise fall back to process.env
    const provider = envVars.NEXT_PUBLIC_AI_PROVIDER || env.NEXT_PUBLIC_AI_PROVIDER || 'openrouter';
    const openaiModelsStr = envVars.NEXT_PUBLIC_OPENAI_MODELS || env.NEXT_PUBLIC_OPENAI_MODELS;
    const openrouterModelsStr = envVars.NEXT_PUBLIC_OPENROUTER_MODELS || env.NEXT_PUBLIC_OPENROUTER_MODELS;
    const groqModelsStr = envVars.NEXT_PUBLIC_GROQ_MODELS || env.NEXT_PUBLIC_GROQ_MODELS;

    // Return current model configuration with safe parsing
    const config: ModelConfig = {
      provider: provider as 'openai' | 'openrouter' | 'groq',
      openaiModels: safeJsonParse(openaiModelsStr, defaultOpenAIModels),
      openrouterModels: safeJsonParse(openrouterModelsStr, defaultOpenRouterModels),
      groqModels: safeJsonParse(groqModelsStr, defaultGroqModels)
    };

    return NextResponse.json(config);
  } catch (error) {
    console.error('Error getting model config:', error);
    return NextResponse.json(
      { error: 'Failed to get model configuration' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const body = await request.json();
    const { provider, openaiModels, openrouterModels, groqModels } = body as ModelConfig;

    // Validate provider
    if (!provider || !['openai', 'openrouter', 'groq'].includes(provider)) {
      return NextResponse.json(
        { error: 'Invalid provider. Must be "openai", "openrouter", or "groq"' },
        { status: 400 }
      );
    }

    // Validate models arrays
    if (!Array.isArray(openaiModels) || !Array.isArray(openrouterModels) || !Array.isArray(groqModels)) {
      return NextResponse.json(
        { error: 'Models must be arrays' },
        { status: 400 }
      );
    }

    // Validate model structure (basic validation for required fields)
    const validateModel = (model: any, index: number, type: string) => {
      if (!model.id || !model.displayName) {
        throw new Error(`${type} model at index ${index} missing required fields (id, displayName)`);
      }

      // Validate reasoning method if reasoning is enabled
      if (model.supportsReasoning && model.reasoningMethod &&
        !['effort', 'max_tokens', 'both', 'none'].includes(model.reasoningMethod)) {
        throw new Error(`${type} model '${model.id}' has invalid reasoningMethod`);
      }
    };

    try {
      openaiModels.forEach((model, i) => validateModel(model, i, 'OpenAI'));
      openrouterModels.forEach((model, i) => validateModel(model, i, 'OpenRouter'));
      groqModels.forEach((model, i) => validateModel(model, i, 'Groq'));
    } catch (validationError) {
      return NextResponse.json(
        { error: validationError instanceof Error ? validationError.message : String(validationError) },
        { status: 400 }
      );
    }

    // Save the configuration to .env.local
    await saveModelConfig(provider, openaiModels, openrouterModels, groqModels);

    return NextResponse.json({
      success: true,
      message: 'Model configuration saved successfully to .env.local',
      config: {
        provider,
        openaiModels,
        openrouterModels,
        groqModels
      }
    });
  } catch (error) {
    console.error('Error updating model config:', error);

    if (error instanceof EnvWriteError) {
      return NextResponse.json(
        { error: 'Model configuration contains a value that cannot be stored in .env.local' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        error: 'Failed to update model configuration',
        details: 'Please check that the .env.local file is writable'
      },
      { status: 500 }
    );
  }
}
