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
  }

  /**
   * 通用的深度合并递归函数
   * 无视关键字，递归字典到最底层进行字符串拼接或值覆盖
   */
  private static deepMerge(target: unknown, source: unknown): unknown {
    // 1. 如果源是字符串，且目标也是字符串，则拼接
    if (typeof source === 'string' && typeof target === 'string') {
      return target + source;
    }

    // 2. 如果源是数组，递归处理每一项（通常用于 tool_calls 的索引拼接）
    if (Array.isArray(source)) {
      const targetArr = Array.isArray(target) ? (target as unknown[]) : [];
      const result = [...targetArr];
      source.forEach((item, index) => {
        result[index] = this.deepMerge(result[index], item);
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
   * 递归处理流式返回
   * 使用通用的 deepMerge，不涉及任何硬编码关键字
   */
  public static async *assembleStreamRecursive(
    iterator: AsyncIterator<OpenAI.Chat.Completions.ChatCompletionChunk>,
    accumulated: unknown = {}
  ): AsyncGenerator<StreamDelta> {
    const result = await iterator.next();

    if (result.done) {
      return;
    }

    const value = result.value;
    const delta = value.choices[0]?.delta;
    const finishReason = value.choices[0]?.finish_reason;
    
    // 执行无视关键字的通用合并
    const newAccumulated = this.deepMerge(accumulated, delta);

    yield {
      delta: delta,
      accumulated: newAccumulated,
      is_done: finishReason !== null && finishReason !== undefined
    };

    // 递归调用
    yield* this.assembleStreamRecursive(iterator, newAccumulated);
  }
}
