import { supabaseAdmin } from '@/lib/supabase';
import { KoyebWebhookPayload, TextMessageOptions, WhatsAppConversation } from './types';
import { WhatsAppMessageConverter } from './message-converter';
import { getSessionManager } from './session-manager';
import { getWhatsAppClient } from './client-factory';
import { logger } from '@/lib/logger';
import { ExtendedMessage } from '@/types/chat';
import { env } from '@/lib/env';
import { nanoid } from 'nanoid';
import { generateTitle, generateSmartTitle } from '@/lib/title-generator';
import { guardChannelReply, readAnswerConfig } from '@/lib/rag';
import { createChatStreamParser, type ChatStreamFacts } from './chat-stream-parser';
import { buildWhatsAppHistory, stampWhatsAppMessage, whatsappHistoryEnabled, withRagMetadata, type WhatsAppStamp } from './history';

function messageText(message: ExtendedMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

type SessionManagerPort = Pick<ReturnType<typeof getSessionManager>, 'getSessionById' | 'updateSessionStatus'>;

/** Injected collaborators for in-process tests and the eval entry point; each defaults to today's singleton. */
export interface WebhookHandlerDeps {
  sessionManager: SessionManagerPort;
  whatsappClient: ReturnType<typeof getWhatsAppClient>;
  db: Pick<typeof supabaseAdmin, 'from'>;
  fetch: typeof fetch;
}

/**
 * Handles incoming webhooks from WhatsApp provider (Koyeb/Fly.io)
 */
export class WhatsAppWebhookHandler {
  private sessionManager: SessionManagerPort;
  private whatsappClient: ReturnType<typeof getWhatsAppClient>;
  private db: Pick<typeof supabaseAdmin, 'from'>;
  private fetchImpl: typeof fetch;

  constructor(deps: Partial<WebhookHandlerDeps> = {}) {
    this.sessionManager = deps.sessionManager ?? getSessionManager();
    this.whatsappClient = deps.whatsappClient ?? getWhatsAppClient();
    this.db = deps.db ?? supabaseAdmin;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Process incoming webhook
   */
  async handleWebhook(payload: KoyebWebhookPayload): Promise<void> {
    logger.info('WhatsAppWebhookHandler', `Processing webhook event: ${payload.event}`);

    try {
      switch (payload.event) {
        case 'message':
          await this.handleMessage(payload);
          break;

        case 'status':
          await this.handleStatusUpdate(payload);
          break;

        case 'qr':
          await this.handleQRUpdate(payload);
          break;

        case 'connected':
          await this.handleConnected(payload);
          break;

        case 'disconnected':
          await this.handleDisconnected(payload);
          break;

        default:
          logger.warn('WhatsAppWebhookHandler', `Unknown webhook event: ${payload.event}`);
      }
    } catch (error) {
      logger.error('WhatsAppWebhookHandler', 'Webhook processing failed:', error);
      throw error;
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(payload: KoyebWebhookPayload): Promise<void> {
    // Handle Baileys webhook format
    if (payload.data.key && !payload.data.from) {
      // Map Baileys fields to expected format
      payload.data.from = payload.data.key.remoteJid;
      payload.data.messageId = payload.data.key.id;
      
      // Extract message content from various formats
      if (payload.data.message) {
        if (payload.data.message.extendedTextMessage?.text) {
          payload.data.message.conversation = payload.data.message.extendedTextMessage.text;
        }
      }
    }
    
    if (!payload.data.from || !payload.data.messageId) {
      logger.warn('WhatsAppWebhookHandler', 'Invalid message payload - missing from or messageId');
      return;
    }

    const { sessionId } = payload;
    const { from: whatsappJid, messageId } = payload.data;
    
    logger.info('WhatsAppWebhookHandler', `Processing message from ${whatsappJid} with ID ${messageId}`);

    // Get session to find user
    const session = await this.sessionManager.getSessionById(sessionId);
    if (!session) {
      logger.error('WhatsAppWebhookHandler', `Session not found: ${sessionId}`);
      return;
    }
    
    // Check session status
    logger.info('WhatsAppWebhookHandler', `Session status: ${session.status}`);
    if (session.status !== 'connected') {
      logger.error('WhatsAppWebhookHandler', `Session is not connected. Status: ${session.status}`);
      // Try to check the actual status from Koyeb
      try {
        const status = await this.whatsappClient.getSessionStatus(sessionId);
        logger.info('WhatsAppWebhookHandler', 'Koyeb session status:', status);
        
        // If Koyeb says it's connected but our DB says otherwise, update it
        if (status.isConnected) {
          logger.info('WhatsAppWebhookHandler', 'Updating session status to connected based on Koyeb status');
          await this.sessionManager.updateSessionStatus(sessionId, 'connected', {
            phoneNumber: whatsappJid.replace('@s.whatsapp.net', '')
          });
        }
      } catch (statusError) {
        logger.error('WhatsAppWebhookHandler', 'Failed to get session status from Koyeb:', statusError);
      }
    }

    // Find or create conversation
    const conversation = await this.findOrCreateConversation(
      session.userId,
      whatsappJid,
      WhatsAppMessageConverter.extractPhoneNumber(whatsappJid)
    );

    // Convert message to myRAG format
    const myRAGMessage = WhatsAppMessageConverter.toMyRAGMessage(payload, session.userId);
    if (!myRAGMessage) {
      logger.warn('WhatsAppWebhookHandler', 'Failed to convert message to myRAG format');
      return;
    }

    // Check for special commands
    if (typeof myRAGMessage.content === 'string') {
      const command = myRAGMessage.content.toLowerCase().trim();
      
      // Handle reset command
      if (command === 'reset' || command === 'new chat' || command === '/reset') {
        logger.info('WhatsAppWebhookHandler', 'Reset command received, clearing conversation history');
        
        // Clear the messages in the database
        const { error: resetError } = await this.db
          .from('chats')
          .update({
            messages: [],
            updated_at: new Date().toISOString()
          })
          .eq('id', conversation.chatId);

        if (resetError) {
          logger.error('WhatsAppWebhookHandler', 'Failed to reset conversation:', resetError);
        }

        // Send confirmation message
        await this.whatsappClient.sendTextMessage(
          sessionId,
          whatsappJid,
          '✅ Conversation reset! I\'m ready to help you with a fresh start. What can I assist you with today?'
        );
        
        return; // Exit early, don't process this as a regular message
      }
    }

    // Store message tracking
    await this.trackMessage(conversation.id, messageId, 'incoming');

    // Process through myRAG
    await this.processMessageThroughMyRAG(conversation, myRAGMessage, session.sessionId, whatsappJid);
  }

  /**
   * Handle status updates
   */
  private async handleStatusUpdate(payload: KoyebWebhookPayload): Promise<void> {
    const { messageId, status } = payload.data;
    
    if (!messageId || !status) {
      return;
    }

    // Update message status in database
    const { error } = await this.db
      .from('whatsapp_messages')
      .update({ status })
      .eq('whatsapp_message_id', messageId);

    if (error) {
      logger.error('WhatsAppWebhookHandler', 'Failed to update message status:', error);
    }
  }

  /**
   * Handle QR code updates
   */
  private async handleQRUpdate(payload: KoyebWebhookPayload): Promise<void> {
    const { sessionId } = payload;
    const { qr } = payload.data;

    if (!qr) {
      return;
    }

    // Calculate expiration (5 minutes from now)
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 5);

    await this.sessionManager.updateSessionStatus(sessionId, 'qr_pending', {
      qrCode: qr,
      qrExpiresAt: expiresAt.toISOString()
    });
  }

  /**
   * Handle successful connection
   */
  private async handleConnected(payload: KoyebWebhookPayload): Promise<void> {
    const { sessionId } = payload;
    const phoneNumber = payload.data.phoneNumber || '';

    await this.sessionManager.updateSessionStatus(sessionId, 'connected', {
      phoneNumber
    });

    logger.info('WhatsAppWebhookHandler', `Session connected: ${sessionId} (${phoneNumber})`);
  }

  /**
   * Handle disconnection
   */
  private async handleDisconnected(payload: KoyebWebhookPayload): Promise<void> {
    const { sessionId } = payload;
    const error = payload.data.error;

    await this.sessionManager.updateSessionStatus(sessionId, 'disconnected', {
      error
    });

    logger.info('WhatsAppWebhookHandler', `Session disconnected: ${sessionId}`);
  }

  /**
   * Find or create WhatsApp conversation
   */
  private async findOrCreateConversation(
    userId: string,
    whatsappJid: string,
    phoneNumber: string
  ): Promise<WhatsAppConversation> {
    // Check if conversation exists
    const { data: existing } = await this.db
      .from('whatsapp_conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('whatsapp_jid', whatsappJid)
      .single();

    if (existing) {
      // Map snake_case to camelCase
      return {
        id: existing.id,
        chatId: existing.chat_id,
        whatsappJid: existing.whatsapp_jid,
        phoneNumber: existing.phone_number,
        contactName: existing.contact_name,
        userId: existing.user_id,
        createdAt: new Date(existing.created_at),
        updatedAt: new Date(existing.updated_at)
      };
    }

    // Create new chat in myRAG using admin client
    const chatId = crypto.randomUUID(); // Use UUID instead of nanoid
    
    // Create chat directly in database without any system messages
    // The chat API will add the appropriate system messages dynamically
    const { error: chatError } = await this.db
      .from('chats')
      .insert({
        id: chatId,
        user_id: userId,
        messages: [], // Empty messages array - system prompt will be added dynamically by chat API
        title: 'New Chat', // Temporary title - will be updated after first AI response
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

    if (chatError) {
      logger.error('WhatsAppWebhookHandler', 'Failed to create chat:', chatError);
      throw new Error('Failed to create chat');
    }

    // Create conversation mapping
    const { data: conversation, error } = await this.db
      .from('whatsapp_conversations')
      .insert({
        chat_id: chatId,
        whatsapp_jid: whatsappJid,
        phone_number: phoneNumber,
        user_id: userId
      })
      .select()
      .single();

    if (error) {
      logger.error('WhatsAppWebhookHandler', 'Failed to create conversation:', error);
      throw error;
    }

    // Map snake_case to camelCase for new conversation
    return {
      id: conversation.id,
      chatId: conversation.chat_id,
      whatsappJid: conversation.whatsapp_jid,
      phoneNumber: conversation.phone_number,
      contactName: conversation.contact_name,
      userId: conversation.user_id,
      createdAt: new Date(conversation.created_at),
      updatedAt: new Date(conversation.updated_at)
    };
  }

  /**
   * Process message through myRAG pipeline
   */
  private async processMessageThroughMyRAG(
    conversation: WhatsAppConversation,
    incoming: ExtendedMessage,
    sessionId: string,
    senderJid: string = conversation.whatsappJid
  ): Promise<void> {
    // D-24: with RAG_WHATSAPP_HISTORY on, every stored turn carries the session and sender it came from
    const historyOn = false && whatsappHistoryEnabled();
    const stamp: WhatsAppStamp = { sessionId, senderJid };
    const message = historyOn ? stampWhatsAppMessage(incoming, stamp) : incoming;
    try {
      // Get existing chat messages
      const { data: chat } = await this.db
        .from('chats')
        .select('messages')
        .eq('id', conversation.chatId)
        .single();

      const existingMessages: ExtendedMessage[] = chat?.messages || [];
      
      // Add new message to chat using admin client
      const updatedMessages = [...existingMessages, message];
      
      // Update chat with new message
      const { error: updateError } = await this.db
        .from('chats')
        .update({
          messages: updatedMessages,
          updated_at: new Date().toISOString()
        })
        .eq('id', conversation.chatId);

      if (updateError) {
        logger.error('WhatsAppWebhookHandler', 'Failed to update chat:', updateError);
        throw new Error('Failed to update chat');
      }

      // Use WhatsApp-specific model for faster responses
      // This is separate from the user's myRAG model preference
      const selectedModel = env.WHATSAPP_DEFAULT_MODEL || 'openai/gpt-4o-mini';
      logger.info('WhatsAppWebhookHandler', `[WHATSAPP] Using WhatsApp-specific model: ${selectedModel}`);

      // Process through myRAG API
      // Use absolute URL for server-side fetch
      // In development, always use localhost to ensure we hit the local server with debug logs
      const isDevelopment = process.env.NODE_ENV === 'development';
      const baseUrl = isDevelopment 
        ? 'http://localhost:3000' 
        : (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000');
      
      logger.info('WhatsAppWebhookHandler', `Using API endpoint: ${baseUrl}/api/chat (isDevelopment: ${isDevelopment})`);
      
      // Switch off: only the current message, as before. On: the D-16 window of this sender's turns in this session (D-24, P-24)
      const history = historyOn ? buildWhatsAppHistory(existingMessages, stamp) : [];
      if (historyOn) console.log('[WhatsApp History] Window built:', { stored: existingMessages.length, turns: history.length });
      const messagesToSend = [...history, message];
      const answerConfig = readAnswerConfig();
      
      const response = await this.fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: messagesToSend, // Always send single message for fresh context
          data: {
            chatId: conversation.chatId,
            settings: {
              // Use user's selected model from database
              model: selectedModel,
              webSearch: env.WHATSAPP_ENABLE_WEB_SEARCH === 'true',
              mcpEnabled: env.WHATSAPP_ENABLE_MCP === 'true',
              maxOutputTokens: parseInt(env.WHATSAPP_MAX_TOKENS || '4096')
            },
            // Add metadata for debugging
            metadata: {
              source: 'whatsapp',
              sessionId: sessionId,
              phoneNumber: conversation.phoneNumber
            },
            // Enable RAG - will use the main system prompt with {{context}}
            disableRAG: false,
            ...(answerConfig.anyNonDefault ? { channel: 'whatsapp' as const } : {})
          }
        })
      });

      if (!response.ok) {
        throw new Error('myRAG processing failed');
      }

      // Stream response and collect full text
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      // The chat route answers with UI-message SSE (data: {part} lines, then data: [DONE]); legacy 0:"text" lines still parse
      const parser = createChatStreamParser();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      logger.info('WhatsAppWebhookHandler', 'Starting to read streaming response...');

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (parser.push(line) === 'done') {
            finished = true;
            break;
          }
        }
      }
      if (finished) {
        await reader.cancel().catch(() => undefined);
      } else {
        buffer += decoder.decode();
        if (buffer.trim()) parser.push(buffer);
      }

      const streamFacts = parser.result();
      let fullResponse = streamFacts.text;

      logger.info('WhatsAppWebhookHandler', `Final response length: ${fullResponse.length}`);
      logger.info('WhatsAppWebhookHandler', `[DEBUG] Original AI response (first 500 chars): ${fullResponse.substring(0, 500)}`);

      // Check if response is empty and provide a fallback
      if (!fullResponse || fullResponse.trim().length === 0) {
        logger.warn('WhatsAppWebhookHandler', 'Empty response from myRAG, using fallback message');
        fullResponse = 'I received your message but couldn\'t generate a proper response. Please try again.';
      }

      // Check for escaped newlines in the response
      // logger.info('WhatsAppWebhookHandler', 'Response newline analysis:', {
      //   hasActualNewlines: fullResponse.includes('\n'),
      //   hasEscapedNewlines: fullResponse.includes('\\n'),
      //   newlineCount: (fullResponse.match(/\n/g) || []).length
      // });

      // Send response back via WhatsApp
      fullResponse = await this.sendWhatsAppResponse(
        sessionId,
        conversation.whatsappJid,
        fullResponse,
        messageText(message),
        conversation.userId,
        streamFacts
      );

      // Store the AI response in the database
      // This ensures the conversation history is complete
      const answer: ExtendedMessage = {
        id: nanoid(),
        role: 'assistant',
        content: fullResponse,
        createdAt: new Date()
      };
      const aiResponse = historyOn ? stampWhatsAppMessage(answer, stamp) : answer;

      // D-22: the turn's streamed standalone query is kept on its user message, as in chat
      const storedTurn = withRagMetadata(message, undefined);
      const finalMessages = [...existingMessages, storedTurn, aiResponse];

      // Update the chat with the complete conversation
      const { error: finalUpdateError } = await this.db
        .from('chats')
        .update({
          messages: finalMessages,
          updated_at: new Date().toISOString()
        })
        .eq('id', conversation.chatId);

      if (finalUpdateError) {
        logger.error('WhatsAppWebhookHandler', 'Failed to update chat with AI response:', finalUpdateError);
        // Don't throw here as the user already received the response
      }

      // Generate and update chat title if this is the first exchange
      // Check if the chat title is still the default "New Chat"
      const { data: currentChat } = await this.db
        .from('chats')
        .select('title')
        .eq('id', conversation.chatId)
        .single();

      if (currentChat && currentChat.title === 'New Chat') {
        try {
          // Generate a basic title immediately
          const basicTitle = generateTitle(finalMessages);
          
          // Update with basic title first
          await this.db
            .from('chats')
            .update({ title: basicTitle })
            .eq('id', conversation.chatId);
          
          logger.info('WhatsAppWebhookHandler', `Updated chat title to: ${basicTitle}`);
          
          // Then generate a smart title asynchronously
          generateSmartTitle(finalMessages)
            .then(async (smartTitle) => {
              if (smartTitle && smartTitle !== basicTitle) {
                await this.db
                  .from('chats')
                  .update({ title: smartTitle })
                  .eq('id', conversation.chatId);
                
                logger.info('WhatsAppWebhookHandler', `Updated chat with smart title: ${smartTitle}`);
              }
            })
            .catch(error => {
              logger.error('WhatsAppWebhookHandler', 'Failed to generate smart title:', error);
            });
        } catch (error) {
          logger.error('WhatsAppWebhookHandler', 'Failed to update chat title:', error);
        }
      }
    } catch (error: any) {
      logger.error('WhatsAppWebhookHandler', 'myRAG processing failed:', error);
      
      // Try to send error message, but don't fail if it doesn't work
      try {
        await this.whatsappClient.sendTextMessage(
          sessionId,
          conversation.whatsappJid,
          'Sorry, I encountered an error processing your message. Please try again.'
        );
      } catch (sendError: any) {
        // If we can't send the error message, it's likely a connection issue
        if (sendError.statusCode === 500) {
          logger.error('WhatsAppWebhookHandler', 
            'Cannot send error message. The WhatsApp session appears to be disconnected on Koyeb.');
          logger.error('WhatsAppWebhookHandler', 
            'Please restart your Baileys deployment on Koyeb and scan the QR code again.');
        }
      }
    }
  }

  /**
   * Send response back via WhatsApp with keep-alive support
   */
  private async sendWhatsAppResponse(
    sessionId: string,
    to: string,
    reply: string,
    userMessage = '',
    ownerUserId?: string,
    streamFacts?: ChatStreamFacts
  ): Promise<string> {
    // Phase 5.2 D-40: the whole reply is filtered before it is split; previews are off per message while the guard is on
    const guarded = await guardChannelReply({
      text: reply,
      userMessage,
      ownerUserId,
      channel: 'whatsapp',
      webResultUrls: streamFacts?.webResultUrls,
      webResultsFlagged: streamFacts?.injectionFlagged,
      answerLanguage: streamFacts?.answerLanguage,
    });
    const response = guarded.text;
    const sendOptions: TextMessageOptions | null = guarded.linkPreviewOff ? { linkPreview: false } : null;

    // Start keep-alive before processing the response
    // This prevents disconnection during long message formatting/sending
    const isFlyyoClient = 'startKeepAlive' in this.whatsappClient;
    if (isFlyyoClient) {
      (this.whatsappClient as any).startKeepAlive(sessionId);
      logger.info('WhatsAppWebhookHandler', 'Started keep-alive for WhatsApp session');
    }

    try {
      // Debug logging for numbers issue
      logger.info('WhatsAppWebhookHandler', `[DEBUG] Pre-format response (first 500 chars): ${response.substring(0, 500)}`);

      // Always use plain text formatting to preserve numbers correctly
      let formatted = WhatsAppMessageConverter.formatPlainTextForWhatsApp(response);

      // Log formatted message for debugging
      logger.info('WhatsAppWebhookHandler', `[DEBUG] Post-format response (first 500 chars): ${formatted.substring(0, 500)}`);

      // Safety net for escaped newlines (should not be needed but kept for safety)
      if (formatted.includes('\\n') && !formatted.includes('\n')) {
        logger.warn('WhatsAppWebhookHandler', 'UNEXPECTED: Formatted text still contains escaped newlines after fix');
        // Replace escaped newlines with actual newlines as a fallback
        formatted = formatted.replace(/\\n/g, '\n');
      }
    
    
      // Split long messages
      const parts = WhatsAppMessageConverter.splitLongMessage(formatted);
      logger.info('WhatsAppWebhookHandler', `Message split into ${parts.length} parts`);

      for (let i = 0; i < parts.length; i++) {
        logger.info('WhatsAppWebhookHandler', `[DEBUG] Sending part ${i + 1}/${parts.length}, length: ${parts[i].length}`);
        logger.info('WhatsAppWebhookHandler', `[DEBUG] Part ${i + 1} content (first 500 chars): ${parts[i].substring(0, 500)}`);
        const result = sendOptions
          ? await this.whatsappClient.sendTextMessage(sessionId, to, parts[i], sendOptions)
          : await this.whatsappClient.sendTextMessage(sessionId, to, parts[i]);

        // Track outgoing message
        const conversation = await this.getConversationByJid(to);
        if (conversation) {
          await this.trackMessage(conversation.id, result.messageId, 'outgoing');
        }
      }
      return response;
    } finally {
      // Stop keep-alive after all messages are sent
      if (isFlyyoClient) {
        (this.whatsappClient as any).stopKeepAlive(sessionId);
        logger.info('WhatsAppWebhookHandler', 'Stopped keep-alive for WhatsApp session');
      }
    }
  }

  /**
   * Track message in database
   */
  private async trackMessage(
    conversationId: string,
    whatsappMessageId: string,
    direction: 'incoming' | 'outgoing'
  ): Promise<void> {
    const { error } = await this.db
      .from('whatsapp_messages')
      .insert({
        conversation_id: conversationId,
        whatsapp_message_id: whatsappMessageId,
        direction,
        status: direction === 'outgoing' ? 'sent' : undefined
      });

    if (error) {
      logger.error('WhatsAppWebhookHandler', 'Failed to track message:', error);
    }
  }

  /**
   * Get conversation by WhatsApp JID
   */
  private async getConversationByJid(whatsappJid: string): Promise<WhatsAppConversation | null> {
    const { data } = await this.db
      .from('whatsapp_conversations')
      .select('*')
      .eq('whatsapp_jid', whatsappJid)
      .single();

    if (!data) {
      return null;
    }

    // Map snake_case to camelCase
    return {
      id: data.id,
      chatId: data.chat_id,
      whatsappJid: data.whatsapp_jid,
      phoneNumber: data.phone_number,
      contactName: data.contact_name,
      userId: data.user_id,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at)
    };
  }
}

// Singleton instance
let webhookHandler: WhatsAppWebhookHandler | null = null;

export function getWebhookHandler(): WhatsAppWebhookHandler {
  if (!webhookHandler) {
    webhookHandler = new WhatsAppWebhookHandler();
  }
  return webhookHandler;
}