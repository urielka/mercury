import fs from "node:fs";
import path from "node:path";
import type { Message } from "chat";
import type { TelegramAdapter } from "../adapters/telegram.js";
import { detectTelegramMedia } from "../adapters/telegram.js";
import { downloadMediaFromUrl } from "../core/media.js";
import { logger } from "../logger.js";
import type {
  EgressFile,
  IngressMessage,
  MessageAttachment,
  NormalizeContext,
  PlatformBridge,
} from "../types.js";

// Re-export the Telegram message type for normalize()
interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    is_bot: boolean;
  };
  chat: { id: number; type: string; title?: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
    file_name?: string;
  };
  video?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
    file_name?: string;
  };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  sticker?: { file_id: string; file_size?: number; is_animated: boolean };
  reply_to_message?: TelegramMessage;
  entities?: Array<{ type: string; offset: number; length: number }>;
  caption_entities?: Array<{ type: string; offset: number; length: number }>;
}

export class TelegramBridge implements PlatformBridge {
  readonly platform = "telegram";

  constructor(private readonly adapter: TelegramAdapter) {}

  parseThread(threadId: string): { externalId: string; isDM: boolean } {
    const parts = threadId.split(":");
    const externalId = parts.slice(1).join(":");
    // Positive chat IDs are private (DM), negative are groups/supergroups/channels
    const chatId = Number(parts[1]);
    const isDM = chatId > 0;
    return { externalId, isDM };
  }

  async normalize(
    threadId: string,
    message: unknown,
    ctx: NormalizeContext,
    spaceId: string,
  ): Promise<IngressMessage | null> {
    const msg = message as Message<TelegramMessage>;
    if (msg.author.isMe) return null;

    const text = msg.text.trim();
    const metadata = msg.metadata as {
      isReplyToBot?: boolean;
    };
    const isReplyToBot = metadata?.isReplyToBot ?? false;

    // Download media in the bridge layer so it lands in the resolved space workspace
    const attachments: MessageAttachment[] = [];
    const rawMsg = msg.raw as TelegramMessage | undefined;

    if (rawMsg && ctx.media.enabled) {
      const mediaInfo = detectTelegramMedia(
        rawMsg as Parameters<typeof detectTelegramMedia>[0],
      );
      if (mediaInfo) {
        const workspace = ctx.getWorkspace(spaceId);
        const inboxDir = path.join(workspace, "inbox");
        try {
          // Check size before downloading
          if (
            mediaInfo.fileSize &&
            mediaInfo.fileSize > ctx.media.maxSizeBytes
          ) {
            logger.warn("Skipping large Telegram media", {
              type: mediaInfo.type,
              sizeBytes: mediaInfo.fileSize,
              maxBytes: ctx.media.maxSizeBytes,
            });
          } else {
            const fileUrl = await this.adapter.getFileUrl(mediaInfo.fileId);
            const result = await downloadMediaFromUrl(fileUrl, {
              type: mediaInfo.type,
              mimeType: mediaInfo.mimeType,
              filename: mediaInfo.filename,
              expectedSizeBytes: mediaInfo.fileSize,
              maxSizeBytes: ctx.media.maxSizeBytes,
              outputDir: inboxDir,
            });
            if (result) {
              attachments.push(result);
            }
          }
        } catch (error) {
          logger.error("Failed to download Telegram media in bridge", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (!text && attachments.length === 0) return null;

    const { externalId, isDM } = this.parseThread(threadId);

    return {
      platform: "telegram",
      spaceId,
      conversationExternalId: externalId,
      callerId: `telegram:${msg.author.userId || "unknown"}`,
      authorName: msg.author.userName,
      text,
      isDM,
      isReplyToBot,
      attachments,
    };
  }

  async sendReply(
    threadId: string,
    text: string,
    files?: EgressFile[],
  ): Promise<void> {
    if (files && files.length > 0) {
      await this.sendFiles(threadId, text, files);
    } else if (text) {
      await this.adapter.postMessage(threadId, text);
    }
  }

  private async sendFiles(
    threadId: string,
    text: string,
    files: EgressFile[],
  ): Promise<void> {
    const chatId = this.adapter.parseChatId(threadId);
    let textSent = !text;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isLast = i === files.length - 1;
      const caption = isLast && !textSent ? text : undefined;

      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(file.path);
      } catch (err) {
        logger.error("Failed to read egress file", {
          path: file.path,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      try {
        const mime = file.mimeType;
        const blob = new Blob([buffer], { type: mime });
        const formData = new FormData();
        formData.append("chat_id", String(chatId));

        if (mime.startsWith("image/")) {
          formData.append("photo", blob, file.filename);
          if (caption) formData.append("caption", caption);
          await this.sendFormData("sendPhoto", formData);
        } else if (mime.startsWith("video/")) {
          formData.append("video", blob, file.filename);
          if (caption) formData.append("caption", caption);
          await this.sendFormData("sendVideo", formData);
        } else if (mime.startsWith("audio/")) {
          formData.append("audio", blob, file.filename);
          await this.sendFormData("sendAudio", formData);
          // Send caption as separate text message for audio
          if (caption) {
            await this.adapter.apiCall("sendMessage", {
              chat_id: chatId,
              text: caption,
            });
          }
        } else {
          formData.append("document", blob, file.filename);
          if (caption) formData.append("caption", caption);
          await this.sendFormData("sendDocument", formData);
        }

        if (caption) textSent = true;
      } catch (err) {
        logger.error("Failed to send file via Telegram", {
          filename: file.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!textSent) {
      await this.adapter.apiCall("sendMessage", {
        chat_id: chatId,
        text,
      });
    }
  }

  private async sendFormData(
    method: string,
    formData: FormData,
  ): Promise<void> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.adapter.botToken}/${method}`,
      {
        method: "POST",
        body: formData,
      },
    );

    const json = (await response.json()) as {
      ok: boolean;
      description?: string;
    };

    if (!json.ok) {
      throw new Error(
        `Telegram API ${method} failed: ${json.description || "unknown error"}`,
      );
    }
  }
}
