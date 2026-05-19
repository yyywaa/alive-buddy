import { CharacterConfig, UnifiedMessage, ImpulseResponse } from '../api/types.js';

export class Character {
  public config: CharacterConfig;
  public runtime_state: {
    mood: number;
    energy: number;
    boredom: number;
    last_interaction_at: number;
    is_active: boolean;
    memory_context: string;
  };

  constructor(config: CharacterConfig, saved_state?: Partial<Character['runtime_state']>) {
    console.log(`[DEBUG] Initializing Character: ${config.name} (${config.id})`);
    this.config = config;
    
    this.runtime_state = {
      mood: config.initial_state.mood ?? 0,
      energy: config.initial_state.energy ?? 100,
      boredom: config.initial_state.boredom ?? 0,
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
    
    // TODO: 实现状态演化逻辑 (State Engine)
    // TODO: 调用决策树判定 (ML Sidecar)
    
    return null;
  }

  /**
   * 被动响应：当接收到用户消息时触发
   */
  public async onMessage(message: UnifiedMessage): Promise<void> {
    console.log(`[DEBUG] [${this.config.name}] Received message:`, JSON.stringify(message, null, 2));
    this.runtime_state.last_interaction_at = Date.now();
    this.runtime_state.boredom = 0; // 收到消息，无聊度归零
    
    console.log(`[DEBUG] [${this.config.name}] Starting reAct loop...`);
    // TODO: 实现 reAct 循环逻辑
  }

  /**
   * 状态导出
   */
  public dumpState(): Partial<Character['runtime_state']> {
    console.log(`[DEBUG] [${this.config.name}] Dumping runtime state.`);
    return { ...this.runtime_state };
  }
}
