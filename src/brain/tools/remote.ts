import axios from 'axios';
import OpenAI from 'openai';
import { BaseTool } from './base.js';
import { Character } from '../character.js';
import { Tool } from '../../api/types.js';

/**
 * 远程工具：定义在本地，执行在客户端（connector）。
 *
 * 这样密钥、出网策略、限流都留在 connector 一层，本服务不需要引入任何新依赖；
 * 也绕开了 Responses API 忽略内置 `mcp` 工具的限制——对模型来说它就只是一个普通 function。
 * 注意 axios 不会自动给非 2xx 抛错之外的信息；这里统一把失败翻译成一段可读 observation，
 * 让角色能"看到"工具坏了并自然绕开，而不是把 reAct 循环打挂。
 */
export class RemoteTool extends BaseTool {
  public readonly definition: OpenAI.Chat.ChatCompletionTool;
  private readonly toolName: string;
  private readonly endpoint: string;

  constructor(definition: Tool, endpoint: string, timeoutMs = 25_000) {
    super();
    this.definition = definition as unknown as OpenAI.Chat.ChatCompletionTool;
    this.toolName = definition.function.name;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }

  private readonly timeoutMs: number;

  public async execute(args: Record<string, unknown>, character: Character): Promise<string> {
    if (!this.endpoint) {
      return `工具 ${this.toolName} 暂不可用：客户端未提供 tool_url。`;
    }

    try {
      const response = await axios.post(
        this.endpoint,
        { name: this.toolName, arguments: args ?? {} },
        {
          timeout: this.timeoutMs,
          headers: character.config.connection.send_headers ?? {},
        },
      );
      const content = (response.data as { content?: unknown } | undefined)?.content;
      if (typeof content === 'string' && content.trim()) {
        return content;
      }
      return `工具 ${this.toolName} 没有返回内容。`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DEBUG] [Tool: ${this.toolName}] 远程调用失败:`, message);
      return `工具 ${this.toolName} 调用失败（${message}）。可以换个说法，或直接承认查不到。`;
    }
  }
}
