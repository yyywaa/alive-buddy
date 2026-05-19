import OpenAI from 'openai';
import { Character } from '../character.js';

export abstract class BaseTool {
  /**
   * 符合 OpenAI 规范的工具定义
   */
  public abstract readonly definition: OpenAI.Chat.ChatCompletionTool;

  /**
   * 工具执行逻辑
   * @param args 工具参数
   * @param character 关联的角色实例
   */
  public abstract execute(
    args: Record<string, unknown>, 
    character: Character
  ): Promise<string>;
}
