import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { v4 as uuidv4 } from 'uuid';
import { Character } from '../brain/character.js';
import { CharacterConfig, UnifiedMessage } from './types.js';
import { ReActLogEntry } from '../brain/react.js';
import { initSQLite } from '../memory/sqlite.js';
import { initChroma } from '../memory/chroma.js';

const fastify = Fastify({ logger: true });
fastify.register(websocket);

// 内存中暂时存储 session 与 character 的映射
const sessions = new Map<string, Character>();

// debug WebSocket 连接管理：session_id -> SocketConnection Set
type DebugSocket = {
  socket: {
    send: (data: string) => void;
    close: () => void;
  };
};
const debugSockets = new Map<string, Set<DebugSocket>>();

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
    
    return { session_id: sessionId };
  });

  // 2. WebSocket 聊天接口
  fastify.get('/v1/chat', { websocket: true }, (connection, req) => {
    console.log('[DEBUG] WebSocket connection established.');

    connection.socket.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        const { session_id, ...msgData } = data;

        if (!isValidUnifiedMessage(data)) {
          connection.socket.send(JSON.stringify({ error: 'Invalid message format' }));
          return;
        }

        console.log(`[DEBUG] WS Received message for session: ${session_id}`);
        
        const character = sessions.get(session_id);
        if (!character) {
          connection.socket.send(JSON.stringify({ error: 'Session not found' }));
          return;
        }

        // 处理消息
        await character.onMessage(msgData as UnifiedMessage);
        
        // 模拟返回
        connection.socket.send(JSON.stringify({
          msg_id: uuidv4(),
          payload: {
            role: 'assistant',
            content: [{ type: 'text', text: `[DEBUG] I received your message: ${JSON.stringify(msgData.payload.content)}` }]
          }
        }));

      } catch (err) {
        console.error('[DEBUG] WS Error:', err);
        connection.socket.send(JSON.stringify({ error: 'Invalid message format' }));
      }
    });

    connection.socket.on('close', () => {
      console.log('[DEBUG] WebSocket connection closed.');
    });
  });

  // 3. Debug 日志 WebSocket 接口
  fastify.get('/v1/session/:id/debug', { websocket: true }, (connection, req) => {
    const { id } = req.params as { id: string };
    console.log(`[DEBUG] Debug WebSocket connection established for session: ${id}`);

    const character = sessions.get(id);
    if (!character) {
      connection.socket.send(JSON.stringify({ error: 'Session not found' }));
      connection.socket.close();
      return;
    }

    if (!character.config.debug) {
      connection.socket.send(JSON.stringify({
        type: 'debug_status',
        enabled: false,
        message: 'Debug mode is disabled for this character. Set CharacterConfig.debug = true to enable reAct logs.'
      }));
      connection.socket.close();
      return;
    }

    const conn: DebugSocket = { socket: connection.socket };
    if (!debugSockets.has(id)) {
      debugSockets.set(id, new Set());
      attachDebugLogger(id, character);
    }
    debugSockets.get(id)!.add(conn);

    connection.socket.send(JSON.stringify({
      type: 'debug_status',
      enabled: true,
      message: 'Debug mode enabled. ReAct logs will be streamed here.'
    }));

    connection.socket.on('close', () => {
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

const start = async () => {
  try {
    // 初始化 SQLite，消息与记忆持久化依赖它
    initSQLite();
    console.log('[DEBUG] SQLite initialized.');

    // 初始化 ChromaDB；若未运行，仅打印警告，不阻塞核心链路
    try {
      await initChroma();
      console.log('[DEBUG] ChromaDB initialized.');
    } catch (err) {
      console.warn('[DEBUG] ChromaDB initialization failed, L3 memory will be disabled:', err);
    }

    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log('[DEBUG] API Server is running on port 3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
