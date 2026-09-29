import OpenAI from 'openai';
import { BaseTool } from './base.js';
import { SendMessageTool } from './send_message.js';
import { InternalMonologueTool } from './internal_monologue.js';
import { SetMoodTool } from './set_mood.js';
import { RemoteTool } from './remote.js';
import type { CharacterConfig, Tool } from '../../api/types.js';

/**
 * 工具注册表类：管理所有可用的工具实例
 * 类似于 Python 模块中的 __init__.py 汇总功能
 */
export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();

  constructor(config?: CharacterConfig) {
    // 默认注册内置核心工具
    this.register(new SendMessageTool());
    this.register(new InternalMonologueTool());
    this.register(new SetMoodTool());

    // 客户端下发的扩展工具（萌娘百科 / 维基 / 币价 / MCP …）在客户端侧执行
    this.registerExtendedTools(config);
  }

  /**
   * 消费 config.extend_tool_list：每个定义注册成一个 RemoteTool。
   * 定义在本地、执行在客户端（connector），因此本服务无需引入任何外部依赖。
   */
  private registerExtendedTools(config?: CharacterConfig): void {
    const definitions = (config?.extend_tool_list ?? []) as Tool[];
    if (definitions.length === 0) return;

    const endpoint = config?.connection.tool_url ?? '';
    if (!endpoint) {
      console.warn('[DEBUG] [ToolRegistry] 收到扩展工具定义但没有 tool_url，这些工具将不可用');
    }

    let registered = 0;
    for (const definition of definitions) {
      const name = definition?.function?.name;
      if (!name) continue;
      if (this.tools.has(name)) {
        console.warn(`[DEBUG] [ToolRegistry] 工具名冲突，跳过扩展工具 ${name}`);
        continue;
      }
      this.register(new RemoteTool(definition, endpoint));
      registered += 1;
    }

    console.log(`[DEBUG] [ToolRegistry] 注册扩展工具 ${registered} 个`);
  }

  /**
   * 注册新工具
   */
  public register(tool: BaseTool): void {
    const name = tool.definition.function.name;
    this.tools.set(name, tool);
  }

  /**
   * 获取工具定义列表，供 OpenAI SDK 调用
   */
  public getDefinitions(): OpenAI.Chat.ChatCompletionTool[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /**
   * 获取工具实例
   */
  public get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }
}

// 导出所有的基础定义
export * from './base.js';
export * from './send_message.js';
export * from './internal_monologue.js';
export * from './set_mood.js';
export * from './remote.js';
