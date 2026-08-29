/**
 * Proactive 决策辅助模块
 *
 * 将 Character 的 runtime_state 与当前时间转换为 ML 模型需要的特征，
 * 并基于模型返回的概率决定是否主动发消息。
 */

import { ProactiveFeatures, ProactiveModelClient, defaultProactiveClient } from '../ml/client.js';

export interface ProactiveDecision {
  shouldAct: boolean;
  probability: number;
  threshold: number;
  features: ProactiveFeatures;
  reason: string;
}

export interface ProactiveEngineOptions {
  /**
   * 触发主动消息的阈值，默认 0.5
   */
  threshold?: number;
  /**
   * 最小两次主动脉冲之间的间隔（毫秒），防止过度打扰，默认 5 分钟
   */
  minIntervalMs?: number;
  /**
   * 自定义 ML 客户端，默认使用 defaultProactiveClient
   */
  client?: ProactiveModelClient;
}

export interface ProactiveState {
  mood: number;
  energy: number;
  boredom: number;
  last_interaction_at: number;
  last_pulse_at?: number;
}

export class ProactiveEngine {
  private readonly threshold: number;
  private readonly minIntervalMs: number;
  private readonly client: ProactiveModelClient;

  constructor(options: ProactiveEngineOptions = {}) {
    this.threshold = options.threshold ?? 0.5;
    this.minIntervalMs = options.minIntervalMs ?? 5 * 60 * 1000;
    this.client = options.client ?? defaultProactiveClient;
  }

  /**
   * 根据角色状态与当前时间构建 ML 特征
   */
  public buildFeatures(state: ProactiveState): ProactiveFeatures {
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const timeCos = Math.cos((2 * Math.PI * hour) / 24);

    const timeSinceLastMsgMs = Date.now() - state.last_interaction_at;
    const timeSinceLastMsg = Math.max(0, timeSinceLastMsgMs / 1000 / 60);

    const period = classifyHour(now.getHours());

    return {
      is_breaking_time: period === 'break',
      is_working_time: period === 'work',
      is_sleeping_time: period === 'sleep',
      time_cos: parseFloat(timeCos.toFixed(3)),
      time_since_last_msg: parseFloat(timeSinceLastMsg.toFixed(1)),
      mood: clampInt(state.mood, -100, 100),
      boredom: clampInt(state.boredom, -100, 100),
      energy: clampInt(state.energy, -100, 100),
      noise: parseFloat(Math.random().toFixed(3)),
    };
  }

  /**
   * 执行一次 proactive 判定
   */
  public async decide(state: ProactiveState): Promise<ProactiveDecision> {
    const features = this.buildFeatures(state);

    // 若距离上次主动行为太近，直接抑制
    const lastPulseAt = state.last_pulse_at;
    if (lastPulseAt && Date.now() - lastPulseAt < this.minIntervalMs) {
      return {
        shouldAct: false,
        probability: 0,
        threshold: this.threshold,
        features,
        reason: 'Too soon since last proactive pulse',
      };
    }

    const probability = await this.client.predict(features);

    if (probability === null) {
      return {
        shouldAct: false,
        probability: 0,
        threshold: this.threshold,
        features,
        reason: 'ML sidecar unavailable',
      };
    }

    const shouldAct = probability >= this.threshold;
    return {
      shouldAct,
      probability,
      threshold: this.threshold,
      features,
      reason: shouldAct
        ? `Probability ${probability.toFixed(3)} >= threshold ${this.threshold}`
        : `Probability ${probability.toFixed(3)} < threshold ${this.threshold}`,
    };
  }
}

/**
 * 根据小时数划分时段类型
 * - sleep: 22:00 ~ 07:59
 * - work:  09:00 ~ 17:59
 * - break: 12:00 ~ 13:59 或 18:00 ~ 21:59
 * - 其余为自由活动时段，三个布尔值均为 false
 */
export function classifyHour(hour: number): 'sleep' | 'work' | 'break' | 'free' {
  if (hour >= 22 || hour < 8) return 'sleep';
  if (hour >= 9 && hour < 18) return 'work';
  if ((hour >= 12 && hour < 14) || (hour >= 18 && hour < 22)) return 'break';
  return 'free';
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * 默认引擎实例
 */
export const defaultProactiveEngine = new ProactiveEngine();
