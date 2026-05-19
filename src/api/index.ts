import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { v4 as uuidv4 } from 'uuid';
import { Character } from '../brain/character.js';
import { CharacterConfig, UnifiedMessage } from './types.js';

const fastify = Fastify({ logger: true });
fastify.register(websocket);

// 内存中暂时存储 session 与 character 的映射
const sessions = new Map<string, Character>();

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

    connection.socket.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        const { session_id, ...msgData } = data;

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

  // 3. 获取状态
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
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log('[DEBUG] API Server is running on port 3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
