import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  Message,
  NotImplementedError,
  parseMarkdown,
  type RawMessage,
  stringifyMarkdown,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import { logger } from "../logger.js";

// ─── Telegram Bot API Types ─────────────────────────────────────────────

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  is_animated: boolean;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  voice?: TelegramVoice;
  sticker?: TelegramSticker;
  reply_to_message?: TelegramMessage;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
}

interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ─── Media Detection ────────────────────────────────────────────────────

export interface TelegramMediaInfo {
  type: "image" | "video" | "audio" | "voice" | "document";
  fileId: string;
  mimeType: string;
  fileSize?: number;
  filename?: string;
}

export function detectTelegramMedia(
  msg: TelegramMessage,
): TelegramMediaInfo | null {
  if (msg.voice) {
    return {
      type: "voice",
      fileId: msg.voice.file_id,
      mimeType: msg.voice.mime_type || "audio/ogg",
      fileSize: msg.voice.file_size,
    };
  }

  if (msg.audio) {
    return {
      type: "audio",
      fileId: msg.audio.file_id,
      mimeType: msg.audio.mime_type || "audio/mpeg",
      fileSize: msg.audio.file_size,
      filename: msg.audio.file_name,
    };
  }

  if (msg.photo && msg.photo.length > 0) {
    // Pick the largest photo
    const largest = msg.photo[msg.photo.length - 1];
    return {
      type: "image",
      fileId: largest.file_id,
      mimeType: "image/jpeg",
      fileSize: largest.file_size,
    };
  }

  if (msg.video) {
    return {
      type: "video",
      fileId: msg.video.file_id,
      mimeType: msg.video.mime_type || "video/mp4",
      fileSize: msg.video.file_size,
      filename: msg.video.file_name,
    };
  }

  if (msg.sticker && !msg.sticker.is_animated) {
    return {
      type: "image",
      fileId: msg.sticker.file_id,
      mimeType: "image/webp",
      fileSize: msg.sticker.file_size,
    };
  }

  if (msg.document) {
    return {
      type: "document",
      fileId: msg.document.file_id,
      mimeType: msg.document.mime_type || "application/octet-stream",
      fileSize: msg.document.file_size,
      filename: msg.document.file_name,
    };
  }

  return null;
}

// ─── Reply Context ──────────────────────────────────────────────────────

function buildReplyContext(
  msg: TelegramMessage,
  botId?: number,
): { text: string; isReplyToBot: boolean } | undefined {
  const reply = msg.reply_to_message;
  if (!reply) return undefined;

  const quotedName =
    reply.from?.first_name ||
    reply.from?.username ||
    String(reply.from?.id ?? "unknown");
  const quotedText = (reply.text || reply.caption || "").trim();
  const quotedMedia = detectTelegramMedia(reply);
  const isReplyToBot = reply.from?.id === botId;

  const attrs = [
    `name="${quotedName}"`,
    `user_id="${reply.from?.id ?? "unknown"}"`,
    `message_id="${reply.message_id}"`,
  ];

  if (quotedMedia) {
    attrs.push(`media_type="${quotedMedia.type}"`);
    attrs.push(`media_mime="${quotedMedia.mimeType}"`);
  }

  const contentParts: string[] = [];
  if (quotedText) {
    contentParts.push(quotedText);
  }
  if (quotedMedia && !quotedText) {
    const typeLabel =
      quotedMedia.type === "voice" ? "voice note" : quotedMedia.type;
    contentParts.push(`[${typeLabel}]`);
  }

  const lines = [
    `<reply_to ${attrs.join(" ")}>`,
    contentParts.join("\n") || "",
    "</reply_to>",
  ];

  return { text: lines.join("\n"), isReplyToBot };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function postableToText(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if (typeof message === "object" && message !== null) {
    if ("markdown" in message && typeof message.markdown === "string")
      return message.markdown;
    if ("ast" in message && message.ast) return stringifyMarkdown(message.ast);
    if ("raw" in message && typeof message.raw === "string") return message.raw;
  }
  return "";
}

function displayName(user?: TelegramUser): string {
  if (!user) return "unknown";
  if (user.first_name && user.last_name)
    return `${user.first_name} ${user.last_name}`;
  return user.first_name || user.username || String(user.id);
}

// ─── Adapter ────────────────────────────────────────────────────────────

export interface TelegramAdapterOptions {
  botToken: string;
  userName?: string;
}

export class TelegramAdapter implements Adapter<string, TelegramMessage> {
  readonly name = "telegram";
  readonly userName: string;
  readonly botToken: string;

  private chat?: ChatInstance;
  private polling = false;
  private pollAbort?: AbortController;
  private lastUpdateId = 0;
  private connectedAtMs = 0;
  private readonly seenMessageIds = new Set<string>();
  private botUser?: TelegramUser;

  constructor(options: TelegramAdapterOptions) {
    this.botToken = options.botToken;
    this.userName = options.userName ?? "mercury";
  }

  get botUserId(): string | undefined {
    return this.botUser ? String(this.botUser.id) : undefined;
  }

  get botUserIdNum(): number | undefined {
    return this.botUser?.id;
  }

  private get apiBase(): string {
    return `https://api.telegram.org/bot${this.botToken}`;
  }

  private get fileBase(): string {
    return `https://api.telegram.org/file/bot${this.botToken}`;
  }

  // ─── Telegram Bot API helpers ──────────────────────────────────────

  async apiCall<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await response.json()) as {
      ok: boolean;
      result: T;
      description?: string;
    };

    if (!json.ok) {
      throw new Error(
        `Telegram API ${method} failed: ${json.description || "unknown error"}`,
      );
    }

    return json.result;
  }

  async getFileUrl(fileId: string): Promise<string> {
    const file = await this.apiCall<TelegramFile>("getFile", {
      file_id: fileId,
    });
    if (!file.file_path) {
      throw new Error(`No file_path returned for file_id ${fileId}`);
    }
    return `${this.fileBase}/${file.file_path}`;
  }

  // ─── Adapter interface ─────────────────────────────────────────────

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.connectedAtMs = Date.now();

    // Verify token and get bot info
    this.botUser = await this.apiCall<TelegramUser>("getMe");
    logger.info("Telegram bot connected", {
      botId: this.botUser.id,
      botName: this.botUser.username,
    });

    // Start long-polling
    this.startPolling();
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.pollAbort = new AbortController();
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.apiCall<TelegramUpdate[]>("getUpdates", {
          offset: this.lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ["message"],
        });

        for (const update of updates) {
          this.lastUpdateId = update.update_id;
          if (update.message) {
            void this.handleIncomingMessage(update.message);
          }
        }
      } catch (error) {
        if (this.polling) {
          logger.error("Telegram poll error", {
            error: error instanceof Error ? error.message : String(error),
          });
          // Back off on error
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  }

  async handleWebhook(
    _request: Request,
    _options?: WebhookOptions,
  ): Promise<Response> {
    return new Response(
      "Telegram adapter uses long polling, no webhook required.",
      { status: 202 },
    );
  }

  encodeThreadId(platformData: string): string {
    return `telegram:${platformData}`;
  }

  decodeThreadId(threadId: string): string {
    const parts = threadId.split(":");
    if (parts.length < 2 || parts[0] !== "telegram") {
      throw new Error(`Invalid Telegram thread ID: ${threadId}`);
    }
    return parts.slice(1).join(":");
  }

  /** Parse the numeric chat ID from a thread ID */
  parseChatId(threadId: string): number {
    return Number(this.decodeThreadId(threadId));
  }

  /** Encode a numeric chat ID into a thread ID */
  encodeFromChatId(chatId: number): string {
    return `telegram:${chatId}`;
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<TelegramMessage>> {
    const chatId = this.parseChatId(threadId);
    const text = postableToText(message).trim();
    if (!text) {
      throw new Error("Cannot send empty Telegram message");
    }

    logger.info("Telegram outbound", {
      chatId,
      preview: text.slice(0, 120),
    });

    const sent = await this.apiCall<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
    });

    return {
      id: String(sent.message_id),
      threadId,
      raw: sent,
    };
  }

  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<TelegramMessage>> {
    throw new NotImplementedError(
      "Telegram edit is not implemented in this adapter",
    );
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError(
      "Telegram delete is not implemented in this adapter",
    );
  }

  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError(
      "Telegram reactions are not implemented in this adapter",
    );
  }

  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError(
      "Telegram reactions are not implemented in this adapter",
    );
  }

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions,
  ): Promise<FetchResult<TelegramMessage>> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const chatId = this.parseChatId(threadId);
    return {
      id: threadId,
      channelId: `telegram:${chatId}`,
      isDM: chatId > 0, // Positive IDs are private chats
      metadata: { chatId },
    };
  }

  parseMessage(raw: TelegramMessage): Message<TelegramMessage> {
    const text = (raw.text || raw.caption || "").trim();
    const threadId = this.encodeFromChatId(raw.chat.id);
    const sender = raw.from;
    const senderName = displayName(sender);
    const replyCtx = buildReplyContext(raw, this.botUser?.id);
    const fullText = [text, replyCtx?.text].filter(Boolean).join("\n\n").trim();

    return new Message({
      id: String(raw.message_id),
      threadId,
      text: fullText,
      formatted: parseMarkdown(fullText),
      raw,
      author: {
        userId: String(sender?.id ?? "unknown"),
        userName: senderName,
        fullName: senderName,
        isBot: sender?.is_bot ? true : "unknown",
        isMe: sender?.id === this.botUser?.id,
      },
      metadata: {
        dateSent: new Date(raw.date * 1000),
        edited: false,
        ...({ isReplyToBot: replyCtx?.isReplyToBot ?? false } as Record<
          string,
          unknown
        >),
      },
      attachments: [],
    });
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async startTyping(threadId: string): Promise<void> {
    const chatId = this.parseChatId(threadId);
    try {
      await this.apiCall("sendChatAction", {
        chat_id: chatId,
        action: "typing",
      });
    } catch {
      // Best-effort
    }
  }

  async shutdown(): Promise<void> {
    this.polling = false;
    this.pollAbort?.abort();
    logger.info("Telegram adapter shut down");
  }

  // ─── Incoming message handling ─────────────────────────────────────

  private async handleIncomingMessage(msg: TelegramMessage): Promise<void> {
    // Skip bot's own messages
    if (msg.from?.id === this.botUser?.id) return;

    const messageKey = `${msg.chat.id}:${msg.message_id}`;
    if (this.seenMessageIds.has(messageKey)) return;
    this.seenMessageIds.add(messageKey);
    if (this.seenMessageIds.size > 5000) this.seenMessageIds.clear();

    // Skip backlog messages
    const tsMs = msg.date * 1000;
    if (this.connectedAtMs && tsMs > 0 && tsMs < this.connectedAtMs - 10_000) {
      logger.debug("Telegram skipping backlog message", {
        chatId: msg.chat.id,
        messageId: msg.message_id,
        tsMs,
      });
      return;
    }

    let baseText = (msg.text || msg.caption || "").trim();
    const replyCtx = buildReplyContext(msg, this.botUser?.id);
    const isReplyToBot = replyCtx?.isReplyToBot ?? false;

    // Replace @botUsername mentions with configured userName for trigger matching
    if (this.botUser?.username) {
      baseText = baseText.replace(
        new RegExp(`@${this.botUser.username}\\b`, "gi"),
        `@${this.userName}`,
      );
    }

    // Detect media presence (download happens in bridge layer)
    const mediaInfo = detectTelegramMedia(msg);
    const hasMedia = mediaInfo !== null;

    if (hasMedia && !baseText) {
      const typeLabel =
        mediaInfo.type === "voice" ? "voice note" : mediaInfo.type;
      baseText = `[Sent ${typeLabel}]`;
    }

    const text = [baseText, replyCtx?.text].filter(Boolean).join("\n\n").trim();
    if (!text && !hasMedia) return;

    const threadId = this.encodeFromChatId(msg.chat.id);
    logger.info("Telegram inbound", {
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      sender: msg.from?.id,
      isReply: Boolean(replyCtx),
      isReplyToBot,
      hasMedia,
      mediaType: mediaInfo?.type,
      preview: text.slice(0, 120),
    });

    const incoming = new Message<TelegramMessage>({
      id: String(msg.message_id),
      threadId,
      text: text || "[Media message]",
      formatted: parseMarkdown(text || "[Media message]"),
      raw: msg,
      isMention: true, // always true — router handles trigger matching
      author: {
        userId: String(msg.from?.id ?? "unknown"),
        userName: displayName(msg.from),
        fullName: displayName(msg.from),
        isBot: msg.from?.is_bot ? true : "unknown",
        isMe: false,
      },
      metadata: {
        dateSent: new Date(msg.date * 1000),
        edited: false,
        ...({ isReplyToBot } as Record<string, unknown>),
      },
      attachments: [],
    });

    this.chat?.processMessage(this, threadId, incoming);
  }
}

export function createTelegramAdapter(
  options: TelegramAdapterOptions,
): TelegramAdapter {
  return new TelegramAdapter(options);
}
