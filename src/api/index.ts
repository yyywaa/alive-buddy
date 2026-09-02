import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Character } from '../brain/character.js';
import { CharacterConfig, UnifiedMessage } from './types.js';
import { ReActLogEntry } from '../brain/react.js';
import { initChroma } from '../memory/chroma.js';

// debug WebSocket 连接管理：session_id -> SocketConnection Set
type DebugSocket = {
  socket: WebSocket;
};

/**
 * 轻量校验 WebSocket 消息是否符合 UnifiedMessage 最小必要结构
 */
function isValidUnifiedMessage(data: unknown): data is UnifiedMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.session_id !== 'string') return false;
  if (typeof msg.user_id !== 'string') return false;
  if (typeof msg.msg_id !== 'string') return false;
  if (typeof msg.timestamp !== 'number') return false;
  if (typeof msg.payload !== 'object' || msg.payload === null) return false;
  const payload = msg.payload as Record<string, unknown>;
  if (payload.role !== 'user' && payload.role !== 'assistant' && payload.role !== 'system') return false;
  if (!Array.isArray(payload.content)) return false;
  return true;
}

export interface ApiServerOptions {
  /**
   * proactive 脉搏间隔（毫秒）。
   * 默认读取环境变量 PULSE_INTERVAL_MS，否则 60_000。
   */
  pulseIntervalMs?: number;
  /**
   * 是否开启 Fastify 内建请求日志，默认 true。测试时可关闭保持输出干净。
   */
  logger?: boolean;
}

/**
 * 构建一个完整的 API 服务实例（路由与会话状态均封装在实例内）。
 * 测试可通过 buildApp() 拿到独立实例并监听任意端口；
 * 生产入口由本文件底部的 start() 调用。
 */
export function buildApp(options: ApiServerOptions = {}): FastifyInstance {
  const fastify = Fastify({ logger: options.logger ?? true });
  fastify.register(websocket);

  // 内存中暂时存储 session 与 character 的映射
  const sessions = new Map<string, Character>();

  // 每个 session 的 proactive 脉搏定时器：周期性驱动 Character.pulse()
  const pulseTimers = new Map<string, NodeJS.Timeout>();

  const debugSockets = new Map<string, Set<DebugSocket>>();

  const pulseIntervalMs = options.pulseIntervalMs ?? Number(process.env.PULSE_INTERVAL_MS ?? 60_000);

  /**
   * 向指定 session 的所有 debug socket 广播日志
   */
  function broadcastDebugLog(sessionId: string, entry: ReActLogEntry) {
    const sockets = debugSockets.get(sessionId);
    if (!sockets || sockets.size === 0) return;

    const payload = JSON.stringify({ type: 'debug_log', entry });
    for (const conn of sockets) {
      try {
        conn.socket.send(payload);
      } catch (err) {
        // 发送失败时忽略，避免单个坏连接阻塞广播
        console.warn(`[DEBUG] Failed to send debug log to session ${sessionId}:`, err);
      }
    }
  }

  /**
   * 为 Character 注册 debug 日志广播回调
   * 同一个 session 的多个 debug socket 会共享同一个回调
   */
  function attachDebugLogger(sessionId: string, character: Character) {
    character.react.onLog = (entry: ReActLogEntry) => {
      broadcastDebugLog(sessionId, entry);
    };
  }

  /**
   * 清理某个 session 的 debug 连接；若全部断开，则取消日志回调
   */
  function detachDebugSocket(sessionId: string, conn: DebugSocket, character?: Character) {
    const sockets = debugSockets.get(sessionId);
    if (sockets) {
      sockets.delete(conn);
      if (sockets.size === 0) {
        debugSockets.delete(sessionId);
        if (character) {
          character.react.onLog = undefined;
        }
      }
    }
  }

  fastify.register(async (fastify) => {
    // 1. 初始化 Session
    fastify.post('/v1/session/init', async (request, reply) => {
      const config = request.body as CharacterConfig;
      const sessionId = uuidv4();

      console.log(`[DEBUG] Received session init request. Assigned Session ID: ${sessionId}`);

      const character = new Character(config);
      sessions.set(sessionId, character);

      // 同一角色重复 init（connector 重连/重启、或服务重启后重 init）都会换新 session_id。
      // L1/L2 记忆按 session_id 隔离提取，不换绑的话角色每次都会"失忆"：
      // 先把上一个会话的记忆划归到新会话名下，再摘除同角色的旧 session（含脉搏定时器），
      // 避免双实例同时思考/发言。
      const prevSessionId = character.runtime_state.last_active_session_id;
      if (prevSessionId && prevSessionId !== sessionId) {
        const moved = character.memoryManager.reassignSession(prevSessionId, sessionId);
        character.runtime_state.last_active_session_id = sessionId;
        console.log(`[DEBUG] 记忆继承: session ${prevSessionId} → ${sessionId}，迁移 ${moved} 条 L1 消息`);
      }
      for (const [sid, ch] of sessions) {
        if (sid !== sessionId && ch.config.id === config.id) {
          const oldTimer = pulseTimers.get(sid);
          if (oldTimer) clearInterval(oldTimer);
          pulseTimers.delete(sid);
          sessions.delete(sid);
          console.log(`[DEBUG] 摘除同角色旧 session: ${sid}`);
        }
      }

      // 挂上 proactive 脉搏：周期性演化状态，并由 ML 决策树判定是否主动发消息
      const timer = setInterval(() => {
        character.pulse().catch((err) => {
          console.error(`[ERROR] Pulse failed for session ${sessionId}:`, err);
        });
      }, pulseIntervalMs);
      pulseTimers.set(sessionId, timer);

      return { session_id: sessionId };
    });

    // 2. WebSocket 聊天接口
    fastify.get('/v1/chat', { websocket: true }, (socket, req) => {
      console.log('[DEBUG] WebSocket connection established.');

      socket.on('message', async (message: Buffer) => {
        try {
          const data = JSON.parse(message.toString());

          if (!isValidUnifiedMessage(data)) {
            socket.send(JSON.stringify({ error: 'Invalid message format' }));
            return;
          }

          console.log(`[DEBUG] WS Received message for session: ${data.session_id}`);

          const character = sessions.get(data.session_id);
          if (!character) {
            socket.send(JSON.stringify({ error: 'Session not found' }));
            return;
          }

          // 处理消息（保留完整 UnifiedMessage，onMessage 需要 session_id 定位会话与记忆）
          await character.onMessage(data);

          // 模拟返回
          socket.send(JSON.stringify({
            msg_id: uuidv4(),
            payload: {
              role: 'assistant',
              content: [{ type: 'text', text: `[DEBUG] I received your message: ${JSON.stringify(data.payload.content)}` }]
            }
          }));

        } catch (err) {
          console.error('[DEBUG] WS Error:', err);
          socket.send(JSON.stringify({ error: 'Invalid message format' }));
        }
      });

      socket.on('close', () => {
        console.log('[DEBUG] WebSocket connection closed.');
      });
    });

    // 3. Debug 日志 WebSocket 接口
    fastify.get('/v1/session/:id/debug', { websocket: true }, (socket, req) => {
      const { id } = req.params as { id: string };
      console.log(`[DEBUG] Debug WebSocket connection established for session: ${id}`);

      const character = sessions.get(id);
      if (!character) {
        socket.send(JSON.stringify({ error: 'Session not found' }));
        socket.close();
        return;
      }

      if (!character.config.debug) {
        socket.send(JSON.stringify({
          type: 'debug_status',
          enabled: false,
          message: 'Debug mode is disabled for this character. Set CharacterConfig.debug = true to enable reAct logs.'
        }));
        socket.close();
        return;
      }

      const conn: DebugSocket = { socket }
      if (!debugSockets.has(id)) {
        debugSockets.set(id, new Set());
        attachDebugLogger(id, character);
      }
      debugSockets.get(id)!.add(conn);

      socket.send(JSON.stringify({
        type: 'debug_status',
        enabled: true,
        message: 'Debug mode enabled. ReAct logs will be streamed here.'
      }));

      socket.on('close', () => {
        console.log(`[DEBUG] Debug WebSocket connection closed for session: ${id}`);
        detachDebugSocket(id, conn, character);
      });
    });

    // 4. 获取状态
    fastify.get('/v1/session/:id/status', async (request, reply) => {
      const { id } = request.params as { id: string };
      const character = sessions.get(id);

      if (!character) {
        reply.status(404).send({ error: 'Session not found' });
        return;
      }

      return character.dumpState();
    });
  });

  // 服务关闭时清理所有脉搏定时器，避免句柄悬挂
  fastify.addHook('onClose', async () => {
    for (const timer of pulseTimers.values()) {
      clearInterval(timer);
    }
    pulseTimers.clear();
  });

  return fastify;
}

/**
 * 生产入口：初始化全局依赖并监听端口
 */
export async function start(): Promise<void> {
  const app = buildApp();
  try {
    // 初始化 ChromaDB；每个 Character 会自行初始化自己的 SQLite，这里只初始化全局向量库
    try {
      await initChroma();
      console.log('[DEBUG] ChromaDB initialized.');
    } catch (err) {
      console.warn('[DEBUG] ChromaDB initialization failed, L3 memory will be disabled:', err);
    }

    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`[DEBUG] API Server is running on port ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// 仅当作为入口直接运行（node/tsx 执行本文件）时才启动监听；
// 被测试或其他模块 import 时只导出 buildApp，不产生副作用。
if (require.main === module) {
  start();
}
