import OpenAI from 'openai';
import { Stream } from 'openai/streaming';
import { CharacterConfig, Tool } from '../api/types.js';

export interface StreamDelta {
  delta: unknown;         // 当前片的原始增量
  accumulated: unknown;   // 递归拼接后的完整对象
  is_done: boolean;       // 流是否结束
}

export class LLMCall {
  private client: OpenAI;
  private config: CharacterConfig;

  constructor(config: CharacterConfig) {
    this.config = config;
    this.client = new OpenAI({
      baseURL: this.config.connection.base_url,
      apiKey: this.config.connection.api_key,
    });
  }

  /**
   * 调用 LLM
   */
  public async call(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    tools?: Tool[],
    signal?: AbortSignal,
    overrideStream?: boolean
  ): Promise<OpenAI.Chat.ChatCompletion | Stream<OpenAI.Chat.ChatCompletionChunk>> {
    const isStream = overrideStream !== undefined ? overrideStream : (this.config.llm_setting?.stream ?? true);
    
    console.log(`[DEBUG] [LLMCall] Calling ${this.config.connection.model} (stream=${isStream})`);

    const baseParams: Omit<OpenAI.Chat.ChatCompletionCreateParams, 'stream'> = {
      model: this.config.connection.model,
      messages: messages,
      tools: (tools as unknown as OpenAI.Chat.ChatCompletionTool[]) || undefined,
      ...this.config.llm_setting,
    };

    try {
      if (isStream) {
        return await this.client.chat.completions.create(
          { ...baseParams, stream: true },
          { signal } // 传递信号
        );
      } else {
        return await this.client.chat.completions.create(
          { ...baseParams, stream: false },
          { signal } // 传递信号
        );
      }
    } catch (err) {
      // 调试：dump 出错请求的消息结构（角色、是否带 reasoning_content/tool_calls）
      const shape = messages.map((m: any) => ({
        role: m.role,
        has_reasoning: m.reasoning_content != null,
        has_tool_calls: Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
        content_type: typeof m.content,
        content_preview: (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))?.slice(0, 80),
      }));
      console.error(`[DEBUG] [LLMCall] request failed, messages shape: ${JSON.stringify(shape)}`);
      throw err;
    }
  }

  /**
   * 通用的深度合并递归函数
   * 无视关键字，递归字典到最底层进行字符串拼接或值覆盖
   */
  private static deepMerge(target: unknown, source: unknown): unknown {
    // 0. 源是 null/undefined：保留目标值。
    // 流式尾帧常携带占位清空字段（如 deepseek thinking 模式的 reasoning_content: null），
    // 直接覆盖会把已累积的思考链抹掉，导致下一轮请求被 API 拒绝。
    if (source === null || source === undefined) {
      return target;
    }

    // 1. 如果源是字符串，且目标也是字符串，则拼接
    if (typeof source === 'string' && typeof target === 'string') {
      return target + source;
    }

    // 2. 源是数组：递归处理每一项。
    // OpenAI 流式 tool_calls 增量携带对象内的 index 字段标识目标槽位，
    // 若直接按数组位置合并，并行工具调用会串位，因此优先按 index 归位。
    if (Array.isArray(source)) {
      const targetArr = Array.isArray(target) ? (target as unknown[]) : [];
      const result = [...targetArr];
      source.forEach((item, index) => {
        const slot = (item !== null && typeof item === 'object' && typeof (item as { index?: unknown }).index === 'number')
          ? (item as { index: number }).index
          : index;
        result[slot] = this.deepMerge(result[slot], item);
      });
      return result;
    }

    // 3. 如果源是对象，递归处理 key
    if (source !== null && typeof source === 'object') {
      const targetObj = (target !== null && typeof target === 'object' && !Array.isArray(target)) 
        ? (target as Record<string, unknown>) 
        : {};
      const sourceObj = source as Record<string, unknown>;
      
      const result: Record<string, unknown> = { ...targetObj };
      Object.keys(sourceObj).forEach(key => {
        result[key] = this.deepMerge(targetObj[key], sourceObj[key]);
      });
      return result;
    }

    // 4. 其他情况（数字、布尔等）直接覆盖
    return source;
  }

  /**
   * 逐片合并流式返回。
   *
   * 注意：这里必须用**循环**而不是递归。
   * 原实现是 `yield* this.assembleStreamRecursive(...)`，每来一个分片就多一层 generator 委托，
   * 长回复（分片数一多）会直接把调用栈打爆：
   *   RangeError: Maximum call stack size exceeded（生产环境实测，任务整轮失败）。
   * 循环写法只占一个栈帧，与分片数量无关。
   */
  public static async *assembleStream(
    iterator: AsyncIterator<OpenAI.Chat.Completions.ChatCompletionChunk>,
    accumulated: unknown = {}
  ): AsyncGenerator<StreamDelta> {
    let current = accumulated;

    while (true) {
      const result = await iterator.next();
      if (result.done) return;

      const value = result.value;
      const choice = value.choices?.[0];
      const delta = choice?.delta;
      const finishReason = choice?.finish_reason;

      // 执行无视关键字的通用合并
      current = this.deepMerge(current, delta);

      yield {
        delta: delta,
        accumulated: current,
        is_done: finishReason !== null && finishReason !== undefined,
      };
    }
  }

  /**
   * @deprecated 名字里的 Recursive 已不准确（现在是循环实现），保留别名以兼容旧调用。
   */
  public static assembleStreamRecursive(
    iterator: AsyncIterator<OpenAI.Chat.Completions.ChatCompletionChunk>,
    accumulated: unknown = {}
  ): AsyncGenerator<StreamDelta> {
    return this.assembleStream(iterator, accumulated);
  }
}
