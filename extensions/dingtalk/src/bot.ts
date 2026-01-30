/**
 * 钉钉消息处理
 *
 * 实现消息解析、策略检查和 Agent 分发
 */

import type { DingtalkRawMessage, DingtalkMessageContext } from "./types.js";
import type { DingtalkConfig } from "./config.js";
import { getDingtalkRuntime, isDingtalkRuntimeInitialized } from "./runtime.js";
import { sendMessageDingtalk } from "./send.js";
import { sendMediaDingtalk } from "./media.js";
import { createAICard, streamAICard, finishAICard, type AICardInstance } from "./card.js";
import { createLogger, type Logger, checkDmPolicy, checkGroupPolicy } from "@openclaw-china/shared";

/**
 * 解析钉钉原始消息为标准化的消息上下文
 * 
 * @param raw 钉钉原始消息对象
 * @returns 解析后的消息上下文
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */
export function parseDingtalkMessage(raw: DingtalkRawMessage): DingtalkMessageContext {
  // 根据 conversationType 判断聊天类型
  // "1" = 单聊 (direct), "2" = 群聊 (group)
  const chatType = raw.conversationType === "2" ? "group" : "direct";
  
  // 提取消息内容
  let content = "";
  
  if (raw.msgtype === "text" && raw.text?.content) {
    // 文本消息：提取 text.content
    content = raw.text.content.trim();
  } else if (raw.msgtype === "audio" && raw.content?.recognition) {
    // 音频消息：提取语音识别文本 content.recognition
    content = raw.content.recognition.trim();
  }
  
  // 检查是否 @提及了机器人
  const mentionedBot = resolveMentionedBot(raw);
  
  // 使用 Stream 消息 ID（如果可用），确保去重稳定
  const messageId = raw.streamMessageId ?? `${raw.conversationId}_${Date.now()}`;
  
  const senderId =
    raw.senderStaffId ??
    raw.senderUserId ??
    raw.senderUserid ??
    raw.senderId;

  return {
    conversationId: raw.conversationId,
    messageId,
    senderId,
    senderNick: raw.senderNick,
    chatType,
    content,
    contentType: raw.msgtype,
    mentionedBot,
    robotCode: raw.robotCode,
  };
}

/**
 * 判断是否 @提及了机器人
 *
 * - 如果提供了 robotCode，则只在 atUsers 包含 robotCode 时判定为提及机器人
 * - 如果缺少 robotCode，则退化为“存在任意 @”的判断
 */
function resolveMentionedBot(raw: DingtalkRawMessage): boolean {
  const atUsers = raw.atUsers ?? [];
  // 只要有 @，就认为机器人被提及（钉钉群聊机器人只有被 @才会收到消息）
  return atUsers.length > 0;
}

/**
 * 入站消息上下文
 * 用于传递给 Moltbot 核心的标准化上下文
 */
export interface InboundContext {
  /** 消息正文 */
  Body: string;
  /** 原始消息正文 */
  RawBody: string;
  /** 命令正文 */
  CommandBody: string;
  /** 发送方标识 */
  From: string;
  /** 接收方标识 */
  To: string;
  /** 会话键 */
  SessionKey: string;
  /** 账户 ID */
  AccountId: string;
  /** 聊天类型 */
  ChatType: "direct" | "group";
  /** 群组主题（群聊时） */
  GroupSubject?: string;
  /** 发送者名称 */
  SenderName?: string;
  /** 发送者 ID */
  SenderId: string;
  /** 渠道提供者 */
  Provider: "dingtalk";
  /** 消息 ID */
  MessageSid: string;
  /** 时间戳 */
  Timestamp: number;
  /** 是否被 @提及 */
  WasMentioned: boolean;
  /** 命令是否已授权 */
  CommandAuthorized: boolean;
  /** 原始渠道 */
  OriginatingChannel: "dingtalk";
  /** 原始接收方 */
  OriginatingTo: string;
}

/**
 * 构建入站消息上下文
 * 
 * @param ctx 解析后的消息上下文
 * @param sessionKey 会话键
 * @param accountId 账户 ID
 * @returns 入站消息上下文
 * 
 * Requirements: 6.4
 */
export function buildInboundContext(
  ctx: DingtalkMessageContext,
  sessionKey: string,
  accountId: string,
): InboundContext {
  const isGroup = ctx.chatType === "group";
  
  // 构建 From 和 To 标识
  const from = isGroup
    ? `dingtalk:group:${ctx.conversationId}`
    : `dingtalk:${ctx.senderId}`;
  const to = isGroup
    ? `chat:${ctx.conversationId}`
    : `user:${ctx.senderId}`;
  
  return {
    Body: ctx.content,
    RawBody: ctx.content,
    CommandBody: ctx.content,
    From: from,
    To: to,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: ctx.chatType,
    GroupSubject: isGroup ? ctx.conversationId : undefined,
    SenderName: ctx.senderNick,
    SenderId: ctx.senderId,
    Provider: "dingtalk",
    MessageSid: ctx.messageId,
    Timestamp: Date.now(),
    WasMentioned: ctx.mentionedBot,
    CommandAuthorized: true,
    OriginatingChannel: "dingtalk",
    OriginatingTo: to,
  };
}

/**
 * 处理 AI Card 流式响应
 * 
 * 通过 Moltbot 核心 API 获取 LLM 响应，并流式更新 AI Card
 * 
 * @param params 处理参数
 * @returns Promise<void>
 */
async function handleAICardStreaming(params: {
  card: AICardInstance;
  cfg: unknown;
  route: { sessionKey: string; accountId: string; agentId?: string };
  inboundCtx: InboundContext;
  dingtalkCfg: DingtalkConfig;
  targetId: string;
  chatType: "direct" | "group";
  logger: Logger;
}): Promise<void> {
  const { card, cfg, route, inboundCtx, dingtalkCfg, targetId, chatType, logger } = params;
  let accumulated = "";

  try {
    const core = getDingtalkRuntime();
    let lastUpdateTime = 0;
    const updateInterval = 300; // 最小更新间隔 ms

    // 创建回复分发器
    const coreChannel = (core as Record<string, unknown>)?.channel as Record<string, unknown> | undefined;
    const replyApi = coreChannel?.reply as Record<string, unknown> | undefined;

    const humanDelay = (replyApi?.resolveHumanDelayConfig as ((cfg: unknown, agentId?: string) => unknown) | undefined)?.(
      cfg,
      route.agentId
    );

    const createDispatcherWithTyping = replyApi?.createReplyDispatcherWithTyping as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    const createDispatcher = replyApi?.createReplyDispatcher as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    const dispatcherResult = createDispatcherWithTyping
      ? createDispatcherWithTyping({
          deliver: async (payload: unknown) => {
            let text = "";
            if (typeof payload === "object" && payload !== null && "text" in payload) {
              const textValue = (payload as Record<string, unknown>)["text"];
              text = typeof textValue === "string" ? textValue : "";
            }
            if (!text.trim()) return;

            accumulated += text;

            // 节流更新，避免过于频繁
            const now = Date.now();
            if (now - lastUpdateTime >= updateInterval) {
              await streamAICard(card, accumulated, false, (msg) => logger.debug(msg));
              lastUpdateTime = now;
            }
          },
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        })
      : {
          dispatcher: createDispatcher?.({
            deliver: async (payload: unknown) => {
              let text = "";
              if (typeof payload === "object" && payload !== null && "text" in payload) {
                const textValue = (payload as Record<string, unknown>)["text"];
                text = typeof textValue === "string" ? textValue : "";
              }
              if (!text.trim()) return;

              accumulated += text;

              const now = Date.now();
              if (now - lastUpdateTime >= updateInterval) {
                await streamAICard(card, accumulated, false, (msg) => logger.debug(msg));
                lastUpdateTime = now;
              }
            },
            humanDelay,
            onError: (err: unknown, info: { kind: string }) => {
              logger.error(`${info.kind} reply failed: ${String(err)}`);
            },
          }),
          replyOptions: {},
          markDispatchIdle: () => undefined,
        };

    const dispatcher = (dispatcherResult as Record<string, unknown>)?.dispatcher as Record<string, unknown> | undefined;
    if (!dispatcher) {
      logger.debug("dispatcher not available");
      return;
    }

    // 分发消息
    const dispatchReplyFromConfig = replyApi?.dispatchReplyFromConfig as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (!dispatchReplyFromConfig) {
      logger.debug("dispatchReplyFromConfig not available");
      return;
    }

    const result = await dispatchReplyFromConfig({
      ctx: inboundCtx,
      cfg,
      dispatcher,
      replyOptions: (dispatcherResult as Record<string, unknown>)?.replyOptions ?? {},
    });

    const markDispatchIdle = (dispatcherResult as Record<string, unknown>)?.markDispatchIdle as (() => void) | undefined;
    markDispatchIdle?.();

    const counts = (result as Record<string, unknown>)?.counts as Record<string, unknown> | undefined;
    logger.debug(`dispatch complete (replies=${counts?.final ?? 0})`);

    // 完成卡片
    await finishAICard(card, accumulated, (msg) => logger.debug(msg));
    logger.info(`AI Card streaming completed with ${accumulated.length} chars`);
  } catch (err) {
    logger.error(`AI Card streaming failed: ${String(err)}`);
    // 尝试用错误信息完成卡片
    try {
      const errorMsg = `⚠️ Response interrupted: ${String(err)}`;
      await finishAICard(card, errorMsg, (msg) => logger.debug(msg));
    } catch (finishErr) {
      logger.error(`Failed to finish card with error: ${String(finishErr)}`);
    }

    // 回退到普通消息发送（使用钉钉 SDK）
    try {
      const fallbackText = accumulated.trim()
        ? accumulated
        : `⚠️ Response interrupted: ${String(err)}`;
      const limit = dingtalkCfg.textChunkLimit ?? 4000;
      for (let i = 0; i < fallbackText.length; i += limit) {
        const chunk = fallbackText.slice(i, i + limit);
        await sendMessageDingtalk({
          cfg: dingtalkCfg,
          to: targetId,
          text: chunk,
          chatType,
        });
      }
      logger.info("AI Card failed; fallback message sent via SDK");
    } catch (fallbackErr) {
      logger.error(`Failed to send fallback message: ${String(fallbackErr)}`);
    }
  }
}

/**
 * 处理钉钉入站消息
 * 
 * 集成消息解析、策略检查和 Agent 分发
 * 
 * @param params 处理参数
 * @returns Promise<void>
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */
export async function handleDingtalkMessage(params: {
  cfg: unknown; // ClawdbotConfig
  raw: DingtalkRawMessage;
  accountId?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  enableAICard?: boolean;
}): Promise<void> {
  const {
    cfg,
    raw,
    accountId = "default",
    enableAICard = false,
  } = params;
  
  // 创建日志器
  const logger: Logger = createLogger("dingtalk", {
    log: params.log,
    error: params.error,
  });
  
  // 解析消息
  const ctx = parseDingtalkMessage(raw);
  const isGroup = ctx.chatType === "group";
  
  logger.debug(`received message from ${ctx.senderId} in ${ctx.conversationId} (${ctx.chatType})`);
  
  // 获取钉钉配置
  const dingtalkCfg = (cfg as Record<string, unknown>)?.channels as Record<string, unknown> | undefined;
  const channelCfg = dingtalkCfg?.dingtalk as DingtalkConfig | undefined;
  
  // 策略检查
  if (isGroup) {
    const groupPolicy = channelCfg?.groupPolicy ?? "allowlist";
    const groupAllowFrom = channelCfg?.groupAllowFrom ?? [];
    const requireMention = channelCfg?.requireMention ?? true;
    
    const policyResult = checkGroupPolicy({
      groupPolicy,
      conversationId: ctx.conversationId,
      groupAllowFrom,
      requireMention,
      mentionedBot: ctx.mentionedBot,
    });
    
    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  } else {
    const dmPolicy = channelCfg?.dmPolicy ?? "pairing";
    const allowFrom = channelCfg?.allowFrom ?? [];
    
    const policyResult = checkDmPolicy({
      dmPolicy,
      senderId: ctx.senderId,
      allowFrom,
    });
    
    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  }
  
  // 检查运行时是否已初始化
  if (!isDingtalkRuntimeInitialized()) {
    logger.warn("runtime not initialized, skipping dispatch");
    return;
  }
  
  try {
    // 获取完整的 Moltbot 运行时（包含 core API）
    const core = getDingtalkRuntime();
    const coreRecord = core as Record<string, unknown>;
    const coreChannel = coreRecord?.channel as Record<string, unknown> | undefined;
    const replyApi = coreChannel?.reply as Record<string, unknown> | undefined;
    const routingApi = coreChannel?.routing as Record<string, unknown> | undefined;
    
    // 检查必要的 API 是否存在
    if (!routingApi?.resolveAgentRoute) {
      logger.debug("core.channel.routing.resolveAgentRoute not available, skipping dispatch");
      return;
    }
    
    if (!replyApi?.dispatchReplyFromConfig) {
      logger.debug("core.channel.reply.dispatchReplyFromConfig not available, skipping dispatch");
      return;
    }

    if (!replyApi?.createReplyDispatcher && !replyApi?.createReplyDispatcherWithTyping) {
      logger.debug("core.channel.reply dispatcher factory not available, skipping dispatch");
      return;
    }
    
    // 解析路由
    const resolveAgentRoute = routingApi.resolveAgentRoute as (opts: Record<string, unknown>) => Record<string, unknown>;
    const route = resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.conversationId : ctx.senderId,
      },
    });
    
    // 构建入站上下文
    const inboundCtx = buildInboundContext(ctx, (route as Record<string, unknown>)?.sessionKey as string, (route as Record<string, unknown>)?.accountId as string);

    // 如果有 finalizeInboundContext，使用它
    const finalizeInboundContext = replyApi?.finalizeInboundContext as ((ctx: InboundContext) => InboundContext) | undefined;
    const finalCtx = finalizeInboundContext ? finalizeInboundContext(inboundCtx) : inboundCtx;

    const dingtalkCfgResolved = channelCfg;
    if (!dingtalkCfgResolved) {
      logger.warn("channel config missing, skipping dispatch");
      return;
    }

    // ===== AI Card 流式处理 =====
    if (enableAICard) {
      const card = await createAICard({
        cfg: dingtalkCfgResolved,
        conversationType: ctx.chatType === "group" ? "2" : "1",
        conversationId: ctx.conversationId,
        senderId: ctx.senderId,
        senderStaffId: raw.senderStaffId,
        log: (msg) => logger.debug(msg),
      });

      if (card) {
        logger.info("AI Card created, using streaming mode");
        await handleAICardStreaming({
          card,
          cfg,
          route: route as { sessionKey: string; accountId: string; agentId?: string },
          inboundCtx: finalCtx,
          dingtalkCfg: dingtalkCfgResolved,
          targetId: isGroup ? ctx.conversationId : ctx.senderId,
          chatType: isGroup ? "group" : "direct",
          logger,
        });
        return;
      } else {
        logger.warn("AI Card creation failed, falling back to normal message");
      }
    }

    // ===== 普通消息模式 =====
    const textApi = coreChannel?.text as Record<string, unknown> | undefined;
    
    const textChunkLimitResolved =
      (textApi?.resolveTextChunkLimit as ((opts: Record<string, unknown>) => number) | undefined)?.(
        {
          cfg,
          channel: "dingtalk",
          defaultLimit: dingtalkCfgResolved.textChunkLimit ?? 4000,
        }
      ) ?? (dingtalkCfgResolved.textChunkLimit ?? 4000);
    const chunkMode = (textApi?.resolveChunkMode as ((cfg: unknown, channel: string) => unknown) | undefined)?.(cfg, "dingtalk");
    const tableMode = "bullets";

    const deliver = async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
      const targetId = isGroup ? ctx.conversationId : ctx.senderId;
      const chatType = isGroup ? "group" : "direct";

      const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      if (mediaUrls.length > 0) {
        for (const mediaUrl of mediaUrls) {
          await sendMediaDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            mediaUrl,
            chatType,
          });
        }
        return;
      }

      const rawText = payload.text ?? "";
      if (!rawText.trim()) return;
      
      const converted = (textApi?.convertMarkdownTables as ((text: string, mode: string) => string) | undefined)?.(
        rawText,
        tableMode
      ) ?? rawText;
      
      const chunks =
        textApi?.chunkTextWithMode && typeof textChunkLimitResolved === "number" && textChunkLimitResolved > 0
          ? (textApi.chunkTextWithMode as (text: string, limit: number, mode: unknown) => string[])(converted, textChunkLimitResolved, chunkMode)
          : [converted];

      for (const chunk of chunks) {
        await sendMessageDingtalk({
          cfg: dingtalkCfgResolved,
          to: targetId,
          text: chunk,
          chatType,
        });
      }
    };

    const humanDelay = (replyApi?.resolveHumanDelayConfig as ((cfg: unknown, agentId?: string) => unknown) | undefined)?.(
      cfg,
      (route as Record<string, unknown>)?.agentId as string | undefined
    );

    const createDispatcherWithTyping = replyApi?.createReplyDispatcherWithTyping as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    const createDispatcher = replyApi?.createReplyDispatcher as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    const dispatcherResult = createDispatcherWithTyping
      ? createDispatcherWithTyping({
          deliver: async (payload: unknown) => {
            await deliver(payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] });
          },
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        })
      : {
          dispatcher: createDispatcher?.({
            deliver: async (payload: unknown) => {
              await deliver(payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] });
            },
            humanDelay,
            onError: (err: unknown, info: { kind: string }) => {
              logger.error(`${info.kind} reply failed: ${String(err)}`);
            },
          }),
          replyOptions: {},
          markDispatchIdle: () => undefined,
        };

    const dispatcher = (dispatcherResult as Record<string, unknown>)?.dispatcher as Record<string, unknown> | undefined;
    if (!dispatcher) {
      logger.debug("dispatcher not available, skipping dispatch");
      return;
    }

    logger.debug(`dispatching to agent (session=${(route as Record<string, unknown>)?.sessionKey})`);

    // 分发消息
    const dispatchReplyFromConfig = replyApi?.dispatchReplyFromConfig as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (!dispatchReplyFromConfig) {
      logger.debug("dispatchReplyFromConfig not available");
      return;
    }

    const result = await dispatchReplyFromConfig({
      ctx: finalCtx,
      cfg,
      dispatcher,
      replyOptions: (dispatcherResult as Record<string, unknown>)?.replyOptions ?? {},
    });

    const markDispatchIdle = (dispatcherResult as Record<string, unknown>)?.markDispatchIdle as (() => void) | undefined;
    markDispatchIdle?.();

    const counts = (result as Record<string, unknown>)?.counts as Record<string, unknown> | undefined;
    logger.debug(`dispatch complete (replies=${counts?.final ?? 0})`);
  } catch (err) {
    logger.error(`failed to dispatch message: ${String(err)}`);
  }
}
