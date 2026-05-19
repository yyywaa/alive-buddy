import OpenAI from 'openai';
import { BaseTool } from './base.js';
import { SendMessageTool } from './send_message.js';
import { InternalMonologueTool } from './internal_monologue.js';

/**
 * 工具注册表类：管理所有可用的工具实例
 * 类似于 Python 模块中的 __init__.py 汇总功能
 */
export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();

  constructor() {
    // 默认注册内置核心工具
    this.register(new SendMessageTool());
    this.register(new InternalMonologueTool());
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
