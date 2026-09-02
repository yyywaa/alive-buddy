import { CharacterConfig, UnifiedMessage, ImpulseResponse } from '../api/types.js';
import { ReActEngine } from './react.js';
import { ToolRegistry } from './tools/index.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { Message as DomainMessage } from '../memory/Message.js';
import { initSQLite } from '../memory/sqlite.js';
import { defaultProactiveEngine, classifyHour } from './proactive.js';
import { isChromaReady } from '../memory/chroma.js';

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
    last_consolidated_at?: number;
    last_state_update_at: number;
  };

  constructor(config: CharacterConfig, saved_state?: Partial<Character['runtime_state']>) {
    console.log(`[DEBUG] Initializing Character: ${config.name} (${config.id})`);
    this.config = config;
    this.react = new ReActEngine(this.config);
    this.toolRegistry = new ToolRegistry();
    this.memoryManager = new MemoryManager(config.id);
    
    this.runtime_state = {
      mood: config.initial_state.mood ?? 50,
      energy: config.initial_state.energy ?? 100,
      boredom: config.initial_state.boredom ?? 0,
      energy_consumption_rate: config.initial_state.energy_consumption_rate ?? 2,
      last_interaction_at: Date.now(),
      last_state_update_at: Date.now(),
      is_active: false,
      memory_context: '',
      // 优先级：initial_state < SQLite 持久化状态 < 显式传入的 saved_state
      ...(this.memoryManager.loadRuntimeState() ?? {}),
      ...saved_state
    };
    console.log(`[DEBUG] Initial State:`, this.runtime_state);
  }

  /**
   * 混合逼近算法：在到达阈值前使用线性速率，接近边界时采用指数逼近。
   */
  private calculateHybridApproach(current: number, target: number, threshold: number, linearRate: number, k: number, timeDelta: number): number {
    const isIncreasing = target > current;
    const c = isIncreasing ? current : -current;
    const t = isIncreasing ? target : -target;
    const th = isIncreasing ? threshold : -threshold;

    let res: number;
    if (c < th) {
      const timeToThreshold = (th - c) / linearRate;
      if (timeDelta <= timeToThreshold) {
        res = c + linearRate * timeDelta;
      } else {
        const remainingTime = timeDelta - timeToThreshold;
        res = t - (t - th) * Math.exp(-k * remainingTime);
      }
    } else {
      res = t - (t - c) * Math.exp(-k * timeDelta);
    }
    return isIncreasing ? res : -res;
  }

  /**
   * 状态自然演化更新函数
   */
  public updateState(): void {
    const now = Date.now();
    const timeDeltaMs = now - this.runtime_state.last_state_update_at;
    const timeDeltaMinutes = timeDeltaMs / (1000 * 60);

    if (timeDeltaMinutes <= 0) return;

    // 1. 无聊度 (Boredom) 逼近 100
    // 0-80 区间采用线性上升 (0.5/min)，>80 后采用指数逼近
    this.runtime_state.boredom = this.calculateHybridApproach(
      this.runtime_state.boredom, 100, 80, 0.5, 0.05, timeDeltaMinutes
    );

    // 2. 精力 (Energy) 逼近 100
    // 0-80 区间采用线性恢复 (1.0/min)，>80 后采用指数逼近
    this.runtime_state.energy = this.calculateHybridApproach(
      this.runtime_state.energy, 100, 80, 1.0, 0.05, timeDeltaMinutes
    );

    // 3. 心情 (Mood) 随时间自然回落到 50（平静状态）
    // Agent 仍可通过 set_mood 工具主动改变心情，但无特殊事件时心情会缓慢趋于中性。
    this.runtime_state.mood = this.calculateHybridApproach(
      this.runtime_state.mood, 50, 80, 0.3, 0.05, timeDeltaMinutes
    );

    this.runtime_state.last_state_update_at = now;

    // 持久化运行状态，保证进程重启后可恢复（崩溃最多丢失一个更新周期内的演化）
    this.memoryManager.saveRuntimeState({
      mood: this.runtime_state.mood,
      energy: this.runtime_state.energy,
      boredom: this.runtime_state.boredom,
      last_interaction_at: this.runtime_state.last_interaction_at,
      is_active: this.runtime_state.is_active,
      last_state_update_at: this.runtime_state.last_state_update_at,
      last_active_session_id: this.runtime_state.last_active_session_id,
    });

    console.log(`[DEBUG] [${this.config.name}] State updated: Mood=${this.runtime_state.mood.toFixed(1)}, Energy=${this.runtime_state.energy.toFixed(1)}, Boredom=${this.runtime_state.boredom.toFixed(1)}`);
  }

  /**
   * 核心脉搏：处理状态自然演化，并判定是否主动触发消息
   */
  public async pulse(): Promise<ImpulseResponse | null> {
    console.log(`[DEBUG] [${this.config.name}] Pulse check triggered.`);
    
    // 脉搏跳动时，先自然演化一下状态
    this.updateState();

    const sessionId = this.runtime_state.last_active_session_id;
    if (!sessionId) {
      console.log(`[DEBUG] [${this.config.name}] No active session, skipping proactive pulse.`);
      return { action: 'none', payload: { reason: 'no_active_session' } };
    }

    // 时间触发：对话空闲超过阈值，判定为对话段落结束，异步总结 L1 → L2
    const idleThresholdMs = (this.config.memory?.idle_summarize_minutes ?? 120) * 60_000;
    if (Date.now() - this.runtime_state.last_interaction_at > idleThresholdMs) {
      this.memoryManager.summarizeToEpisode(this.config, sessionId, Date.now())
        .catch((err) => console.error(`[ERROR] [${this.config.name}] 空闲总结失败:`, err));
    }

    // 睡眠期固化：睡眠时段内，以最小间隔为限，异步将 L2 事件提炼为 L3 长期印象
    const consolidateIntervalMs = this.config.memory?.consolidate_interval_ms ?? 6 * 60 * 60 * 1000;
    const lastConsolidatedAt = this.runtime_state.last_consolidated_at ?? 0;
    if (
      classifyHour(new Date().getHours()) === 'sleep'
      && Date.now() - lastConsolidatedAt > consolidateIntervalMs
      && isChromaReady()
    ) {
      this.runtime_state.last_consolidated_at = Date.now();
      for (const sid of this.memoryManager.getSessionIds()) {
        this.memoryManager.consolidateToSemantic(this.config, sid, Date.now())
          .catch((err) => console.error(`[ERROR] [${this.config.name}] 睡眠期固化失败:`, err));
      }
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
            text: '（系统提示：这是你自己的主动意识被唤醒了——没有任何人@你或对你说话，是你决定开口的。这不是指令，请仅把它当作一个可供参考的内部状态信号。你可以根据当前心情、精力和记忆决定是否回复；如果认为没有必要，直接保持沉默也完全合理。）'
          },
        ],
      },
    };

    // 写入 L1 感知层，否则 prepareContext 提取的上下文里看不到这次唤醒，
    // 角色无法区分自己是被 pulse 主动唤醒还是在回应用户消息
    this.memoryManager.addMessage(new DomainMessage(triggerMessage));

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
    
    // 收到消息时，先进行自然演化，计算距离上次更新流失的状态
    this.updateState();
    
    this.runtime_state.last_interaction_at = Date.now();
    this.runtime_state.last_active_session_id = message.session_id;
    this.runtime_state.boredom = 0; // 交互发生，无聊度归零
    
    // 持久化当前消息到 L1 感知层
    this.memoryManager.addMessage(new DomainMessage(message));

    // 容量触发：L1 超出警戒水位时，异步将最旧的消息总结为 L2 事件梗概
    const l1Capacity = this.config.memory?.l1_capacity ?? 20;
    if (this.memoryManager.getMessageCount(message.session_id) > l1Capacity) {
      const cutoff = this.memoryManager.getCutoffTimestamp(message.session_id, l1Capacity);
      if (cutoff !== null) {
        this.memoryManager.summarizeToEpisode(this.config, message.session_id, cutoff)
          .catch((err) => console.error(`[ERROR] [${this.config.name}] L1→L2 容量总结失败:`, err));
      }
    }
    
    if (message.silent) {
      console.log(`[DEBUG] [${this.config.name}] Silent message received, skipping reAct loop.`);
      return;
    }
    
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
