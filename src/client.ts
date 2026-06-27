import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import path from 'path';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { CharacterConfig, UnifiedMessage } from './api/types.js';

export interface ClientOptions {
  config: CharacterConfig;
  /**
   * 选择要由 Client 自动拉起的后台服务
   * 如果你在外部已经启动了这些服务，可以在这里设为 false
   */
  services?: {
    api?: boolean;    // TS 主服务 (Fastify)
    ml?: boolean;     // ML Sidecar (Python)
    chroma?: boolean; // ChromaDB
  };
  /**
   * 是否在 Client 内部拦截 Agent 发出的消息 (触发 message 事件)。
   * 如果设为 false (YOLO Mode)，将不启动内部 Webhook，直接信任原 config 中的 send_url 将消息推送到外部。
   * 默认为 true。
   */
  interceptMessage?: boolean;
  chromaPath?: string;
  mlSidecarPath?: string;
  apiServerPath?: string;
}

/**
 * 外部调用的 SDK Client
 * 自动管理服务进程、自动建立 WebSocket、并在内部架设 Webhook 拦截 Agent 的消息
 */
export class AliveBuddyClient extends EventEmitter {
  private config: CharacterConfig;
  private options: ClientOptions;
  private processes: ChildProcess[] = [];
  private ws: WebSocket | null = null;
  private debugWs: WebSocket | null = null;
  private webhookServer: ReturnType<typeof Fastify> | null = null;
  private sessionId: string | null = null;
  
  constructor(options: ClientOptions) {
    super();
    this.options = options;
    // 深拷贝一份配置，以便在内部修改 send_url
    this.config = JSON.parse(JSON.stringify(options.config));
  }

  public async start() {
    console.log('[AliveBuddyClient] Starting client...');

    // 1. 根据 YOLO 模式决定是否架设本地 Webhook
    if (this.options.interceptMessage !== false) {
      await this.setupWebhook();
    } else {
      console.log('[AliveBuddyClient] YOLO Mode enabled: message interception is off. Agent will directly POST to configured send_url.');
    }
    
    // 2. 启动各项子服务
    if (this.options.services?.chroma) {
       console.log('[AliveBuddyClient] Spawning ChromaDB...');
       this.spawnService('chroma', ['run', '--path', this.options.chromaPath || './data/chroma', '--port', '8000']);
    }
    if (this.options.services?.ml) {
       console.log('[AliveBuddyClient] Spawning ML Sidecar...');
       const mlPath = this.options.mlSidecarPath || path.join(process.cwd(), 'src/ml/app.py');
       this.spawnService(process.platform === 'win32' ? 'python' : 'python3', [mlPath]);
    }
    if (this.options.services?.api) {
       console.log('[AliveBuddyClient] Spawning API Server...');
       const apiPath = this.options.apiServerPath || path.join(process.cwd(), 'src/api/index.ts');
       if (apiPath.endsWith('.ts')) {
         // 开发环境下通过 npx tsx 拉起
         this.spawnService('npx', ['tsx', apiPath]);
       } else {
         // 生产环境下通过 node 拉起
         this.spawnService('node', [apiPath]);
       }
    }

    // 等待依赖服务启动 (简易 sleep 策略，实际可优化为健康检查)
    if (this.options.services?.api || this.options.services?.ml || this.options.services?.chroma) {
        console.log('[AliveBuddyClient] Waiting 3 seconds for services to be ready...');
        await new Promise(r => setTimeout(r, 3000));
    }

    // 3. 注册 Session 并建立 WebSocket 通信
    await this.initSession();
    console.log(`[AliveBuddyClient] Session initialized: ${this.sessionId}`);
  }

  private async setupWebhook() {
    this.webhookServer = Fastify();
    this.webhookServer.post('/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { content: string };
      // 触发 message 事件，调用方可通过 client.on('message', ...) 拿到
      this.emit('message', body.content);
      return { ok: true };
    });

    const address = await this.webhookServer.listen({ port: 0, host: '127.0.0.1' });
    console.log(`[AliveBuddyClient] Internal webhook listening at ${address}/webhook`);
    
    // 动态覆盖 config，让 agent 的 send_message 工具乖乖发回这个内部 webhook
    this.config.connection.send_url = `${address}/webhook`;
    this.config.connection.send_headers = {}; // 清空无用的鉴权
  }

  private async initSession() {
    const res = await fetch('http://127.0.0.1:3000/v1/session/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.config)
    });
    
    if (!res.ok) {
        throw new Error(`Failed to init session: ${await res.text()}`);
    }
    
    const data = await res.json() as { session_id: string };
    this.sessionId = data.session_id;

    // 连接主聊天 WS
    this.ws = new WebSocket('ws://127.0.0.1:3000/v1/chat');
    this.ws.on('open', () => this.emit('ready'));
    this.ws.on('error', (err) => this.emit('error', err));

    // 连接 Debug WS
    if (this.config.debug) {
      this.debugWs = new WebSocket(`ws://127.0.0.1:3000/v1/session/${this.sessionId}/debug`);
      this.debugWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'debug_log') {
            this.emit('debug', msg.entry);
          }
        } catch(e) {}
      });
    }
  }

  /**
   * 发送消息给智能体
   */
  public sendMessage(text: string, silent: boolean = false) {
    if (!this.ws || !this.sessionId) throw new Error('Client not ready, call start() first');
    
    const unifiedMsg: UnifiedMessage = {
      msg_id: uuidv4(),
      user_id: 'local-client-user',
      session_id: this.sessionId,
      timestamp: Date.now(),
      silent,
      payload: {
        role: 'user',
        content: [{ type: 'text', text }]
      }
    };
    this.ws.send(JSON.stringify(unifiedMsg));
  }

  /**
   * 停止所有子进程与连接
   */
  public stop() {
    this.ws?.close();
    this.debugWs?.close();
    if (this.webhookServer) {
      this.webhookServer.close();
    }
    for (const p of this.processes) {
      p.kill();
    }
    console.log('[AliveBuddyClient] Stopped all services.');
  }

  private spawnService(command: string, args: string[]) {
    // 忽略标准输出以免刷屏，但保留 stderr 供排查
    const proc = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    this.processes.push(proc);
  }
}
