import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { env } from '@/lib/env';
import { requireSessionUser } from '@/lib/session-auth';
import {
  elevenLabsTextToSpeech,
  elevenLabsSpeechToText,
  isElevenLabsConfigured
} from '@/lib/elevenlabs-utils';

export const runtime = 'nodejs'; // Force Node.js runtime

const VOICE_UNAVAILABLE_MESSAGE = 'Voice is temporarily unavailable.';

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  openaiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

function voiceUnavailable(reason: string) {
  console.warn('[Audio API] Voice unavailable:', reason);
  return NextResponse.json(
    { success: false, error: 'voice_unavailable', message: VOICE_UNAVAILABLE_MESSAGE },
    { status: 503 },
  );
}

// Shared function to handle audio generation
async function handleAudioRequest(
  action: string,
  text: string | null,
  audioFile: File | null,
  providerParam: string | null,
  voiceId: string | null
) {
  const provider =
    providerParam ||
    env.NEXT_PUBLIC_VOICE_PROVIDER ||
    'openai';

  // Validate provider availability
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    return voiceUnavailable('OPENAI_API_KEY is not configured');
  }

  if (provider === 'elevenlabs' && !isElevenLabsConfigured()) {
    // Fallback to OpenAI if ElevenLabs is not configured
    if (process.env.OPENAI_API_KEY) {
      console.warn('ElevenLabs not configured, falling back to OpenAI');
    } else {
      return voiceUnavailable('no voice provider is configured');
    }
  }

  if (action === 'speech') {
    if (!text) {
      return new NextResponse('Text is required', { status: 400 });
    }

    // Use ElevenLabs if selected and configured
    if (provider === 'elevenlabs' && isElevenLabsConfigured()) {
      try {
        const ttsOptions: Parameters<typeof elevenLabsTextToSpeech>[0] = { text };

        // Only include voice_id if it's provided
        if (voiceId) {
          ttsOptions.voice_id = voiceId;
        }

        const stream = await elevenLabsTextToSpeech(ttsOptions);

        // Convert ReadableStream to Response
        return new Response(stream, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
          },
        });
      } catch (elevenLabsError) {
        console.error('ElevenLabs TTS error, falling back to OpenAI:', elevenLabsError);
        // Fall through to OpenAI
      }
    }

    // Use OpenAI (default or fallback)
    if (!process.env.OPENAI_API_KEY) {
      return voiceUnavailable('no TTS provider available');
    }

    const response = await getOpenAI().audio.speech.create({
      model: "tts-1",
      voice: "onyx",
      input: text,
    });

    return new Response(response.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
      },
    });
  }

  else if (action === 'transcribe') {
    if (!audioFile) {
      return new NextResponse('Audio file is required', { status: 400 });
    }

    // Use ElevenLabs if selected and configured
    if (provider === 'elevenlabs' && isElevenLabsConfigured()) {
      try {
        const audioBlob = new Blob([await audioFile.arrayBuffer()], { type: audioFile.type });
        const transcription = await elevenLabsSpeechToText({
          audio: audioBlob,
        });

        return NextResponse.json({ text: transcription });
      } catch (elevenLabsError) {
        console.error('ElevenLabs STT error, falling back to OpenAI:', elevenLabsError);
        // Fall through to OpenAI
      }
    }

    // Use OpenAI (default or fallback)
    if (!process.env.OPENAI_API_KEY) {
      return voiceUnavailable('no STT provider available');
    }

    const transcription = await getOpenAI().audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    });

    return NextResponse.json({ text: transcription.text });
  }

  else {
    return new NextResponse('Invalid action', { status: 400 });
  }
}

export async function GET(req: Request) {
  const auth = await requireSessionUser('[Audio API]');
  if ('response' in auth) return auth.response;
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action') || 'speech'; // Default to speech for GET
    const text = searchParams.get('text');
    const provider = searchParams.get('provider');
    const voiceId = searchParams.get('voiceId');

    return await handleAudioRequest(action, text, null, provider, voiceId);
  } catch (error) {
    console.error('Audio API GET error:', error);
    if (error instanceof Error) {
      return new NextResponse(`Error: ${error.message}`, { status: 500 });
    }
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireSessionUser('[Audio API]');
  if ('response' in auth) return auth.response;
  try {
    const formData = await req.formData();
    const action = formData.get('action') as string;
    const text = formData.get('text') as string | null;
    const audioFile = formData.get('file') as File | null;
    const provider = formData.get('provider') as string | null;
    const voiceId = formData.get('voiceId') as string | null;

    return await handleAudioRequest(action, text, audioFile, provider, voiceId);
  } catch (error) {
    console.error('Audio API POST error:', error);
    if (error instanceof Error) {
      return new NextResponse(`Error: ${error.message}`, { status: 500 });
    }
    return new NextResponse('Internal Server Error', { status: 500 });
  }
} 