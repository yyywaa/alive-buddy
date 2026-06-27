import OpenAI from 'openai';
import { BaseTool } from './base.js';
import { Character } from '../character.js';

/**
 * 情绪控制工具：允许 Agent 在发生特殊事件时，主动改变自己的情绪状态
 */
export class SetMoodTool extends BaseTool {
  public readonly definition: OpenAI.Chat.ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'set_mood',
      description: '设置你的心情值 (mood)。0 表示极度忧郁/难过，50 表示平静，100 表示极度狂喜。注：你的心情会随着时间推移自然趋向于 50，因此无需为了平复心情而反复调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          mood: {
            type: 'number',
            description: '新的心情值，范围 0 到 100'
          },
          reason: {
            type: 'string',
            description: '导致情绪变化的原因（仅作内部日志记录）'
          }
        },
        required: ['mood', 'reason']
      }
    }
  };

  public async execute(
    args: Record<string, unknown>, 
    character: Character
  ): Promise<string> {
    const newMood = args.mood as number;
    const reason = args.reason as string;
    
    if (typeof newMood !== 'number' || newMood < 0 || newMood > 100) {
      return "执行失败：心情值必须是 0 到 100 之间的有效数字。";
    }

    // 先触发一次自然演化，将精力/无聊度/时间戳对齐到当前时刻
    character.updateState();
    
    const oldMood = character.runtime_state.mood;
    character.runtime_state.mood = newMood;
    
    console.log(`[DEBUG] [Tool: SetMood] ${character.config.name} mood updated: ${oldMood.toFixed(1)} -> ${newMood.toFixed(1)}. Reason: ${reason}`);
    
    return `心情值已成功修改为 ${newMood.toFixed(1)}。`;
  }
}
