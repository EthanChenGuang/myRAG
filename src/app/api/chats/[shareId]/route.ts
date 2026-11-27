import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { accessGroupsEnabled } from '@/lib/rag';
import { canViewShared, sharedViewerId } from '@/lib/chat-share-access';

export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }
    
    // Extract shareId from URL pathname
    const pathname = request.nextUrl.pathname;
    const shareId = pathname.split('/').pop();

    if (!shareId) {
      return NextResponse.json(
        { error: 'Share ID is required' },
        { status: 400 }
      );
    }

    // Fetch the shared chat
    const { data: chat, error } = await supabase
      .from('chats')
      .select(accessGroupsEnabled() ? 'id, title, messages, created_at, updated_at' : 'title, messages, created_at, updated_at')
      .eq('share_id', shareId)
      .eq('shared', true)
      .single();

    // D-27: a viewer who may not see every cited document gets the same answer as for an unknown share id.
    if (error || !chat || !(await canViewShared(chat, () => sharedViewerId({ headers: request.headers })))) {
      return NextResponse.json(
        { error: 'Chat not found' },
        { status: 404 }
      );
    }

    // Return only the necessary chat data
    return NextResponse.json({
      chat: {
        title: chat.title,
        messages: chat.messages,
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
      }
    });
  } catch (error) {
    console.error('Error fetching shared chat:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 