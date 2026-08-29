/**
 * ML Sidecar 客户端
 *
 * 负责与 Python FastAPI 服务（src/ml/app.py）通信，
 * 获取 proactive 决策概率。
 */

export interface ProactiveFeatures {
  is_breaking_time: boolean;
  is_working_time: boolean;
  is_sleeping_time: boolean;
  time_cos: number;
  time_since_last_msg: number;
  mood: number;
  boredom: number;
  energy: number;
  noise: number;
}

export interface PredictResponse {
  probability: number;
}

export interface ProactiveModelClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export class ProactiveModelClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ProactiveModelClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  /**
   * 向 ML sidecar 请求 proactive 概率
   * @returns 0~1 的概率值；sidecar 不可用时返回 null，业务方可自行降级
   */
  public async predict(features: ProactiveFeatures): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(features),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(`[MLClient] Sidecar returned ${response.status}: ${await response.text()}`);
        return null;
      }

      const data = (await response.json()) as PredictResponse;
      return typeof data.probability === 'number' ? data.probability : null;
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        console.warn('[MLClient] Sidecar predict timeout');
      } else {
        console.warn(`[MLClient] Sidecar unreachable: ${error.message}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 默认单例：从环境变量读取 sidecar 地址
 */
export const defaultProactiveClient = new ProactiveModelClient({
  baseUrl: process.env.ML_SIDECAR_URL ?? 'http://127.0.0.1:8001',
});
