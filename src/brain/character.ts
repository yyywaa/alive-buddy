import { CharacterConfig, UnifiedMessage, ImpulseResponse } from '../api/types.js';
import { ReActEngine } from './react.js';
import { ToolRegistry } from './tools/index.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { Message as DomainMessage } from '../memory/Message.js';
import { initSQLite } from '../memory/sqlite.js';
import { defaultProactiveEngine } from './proactive.js';

export class Character {
  public config: CharacterConfig;
  public react: ReActEngine;
  public toolRegistry: ToolRegistry;
  public memoryManager: MemoryManager;
  public runtime_state: {
    mood: number;
    energy: number;
    boredom: number;
    energy_consumption_rate: number;
    last_interaction_at: number;
    is_active: boolean;
    memory_context: string;
    last_active_session_id?: string;
    last_pulse_at?: number;
  };

  constructor(config: CharacterConfig, saved_state?: Partial<Character['runtime_state']>) {
    console.log(`[DEBUG] Initializing Character: ${config.name} (${config.id})`);
    this.config = config;
    this.react = new ReActEngine(this.config);
    this.toolRegistry = new ToolRegistry();
    this.memoryManager = new MemoryManager(config.id);
    
    this.runtime_state = {
      mood: config.initial_state.mood ?? 0,
      energy: config.initial_state.energy ?? 100,
      boredom: config.initial_state.boredom ?? 0,
      energy_consumption_rate: config.initial_state.energy_consumption_rate ?? 2,
      last_interaction_at: Date.now(),
      is_active: false,
      memory_context: '',
      ...saved_state
    };
    console.log(`[DEBUG] Initial State:`, this.runtime_state);
  }

  /**
   * 核心脉搏：处理状态自然演化，并判定是否主动触发消息
   */
  public async pulse(): Promise<ImpulseResponse | null> {
    console.log(`[DEBUG] [${this.config.name}] Pulse check triggered.`);

    const sessionId = this.runtime_state.last_active_session_id;
    if (!sessionId) {
      console.log(`[DEBUG] [${this.config.name}] No active session, skipping proactive pulse.`);
      return { action: 'none', payload: { reason: 'no_active_session' } };
    }

    // 调用 ML sidecar 进行 proactive 判定
    const decision = await defaultProactiveEngine.decide(this.runtime_state);
    console.log(`[DEBUG] [${this.config.name}] Proactive decision:`, decision);

    if (!decision.shouldAct) {
      return {
        action: 'none',
        payload: {
          reason: decision.reason,
          features: decision.features,
          probability: decision.probability,
        },
      };
    }

    // 更新上次主动脉冲时间，避免过于频繁
    this.runtime_state.last_pulse_at = Date.now();

    // 构造一个轻量的“自我触发”消息，用于在记忆中定位会话
    const triggerMessage: UnifiedMessage = {
      msg_id: `proactive-${Date.now()}`,
      user_id: this.config.id,
      session_id: sessionId,
      timestamp: Date.now(),
      payload: {
        role: 'system',
        content: [
          {
            type: 'text',
            text: '（系统提示：你感到一阵想要主动联系对方的冲动，请根据当前状态与记忆，决定是否发送一条自然、温暖的消息。）',
          },
        ],
      },
    };

    // 触发 reAct 循环，让角色自主决定具体说什么
    await this.react.run(this, triggerMessage);

    return {
      action: 'send',
      payload: {
        reason: decision.reason,
        features: decision.features,
        probability: decision.probability,
      },
    };
  }

  /**
   * 被动响应：当接收到用户消息时触发
   */
  public async onMessage(message: UnifiedMessage): Promise<void> {
    console.log(`[DEBUG] [${this.config.name}] Received message:`, JSON.stringify(message, null, 2));
    this.runtime_state.last_interaction_at = Date.now();
    this.runtime_state.last_active_session_id = message.session_id;
    this.runtime_state.boredom = 0; // 收到消息，无聊度归零
    
    // 持久化当前消息到 L1 感知层
    this.memoryManager.addMessage(new DomainMessage(message));
    
    console.log(`[DEBUG] [${this.config.name}] Starting reAct loop...`);
    await this.react.run(this, message);
  }

  /**
   * 状态导出
   */
  public dumpState(): Partial<Character['runtime_state']> {
    console.log(`[DEBUG] [${this.config.name}] Dumping runtime state.`);
    return { ...this.runtime_state };
  }
}
