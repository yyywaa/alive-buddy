import OpenAI from 'openai';
import { BaseTool } from './base.js';
import { Character } from '../character.js';
import { Message as DomainMessage } from '../../memory/Message.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * 内部嘀咕工具：允许 Agent 记录内心活动而不发送消息
 * 实质上是更新 Character 的 runtime_state.memory_context
 */
export class InternalMonologueTool extends BaseTool {
  public readonly definition: OpenAI.Chat.ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'internal_monologue',
      description: '记录你内心的思考或嘀咕，用户看不见。用于理清思路或记录不适合直接告诉用户的想法。',
      parameters: {
        type: 'object',
        properties: {
          thought: {
            type: 'string',
            description: '你的内心独白'
          }
        },
        required: ['thought']
      }
    }
  };

  public async execute(
    args: Record<string, unknown>, 
    character: Character,
    contextMessage?: import('../../api/types.js').UnifiedMessage
  ): Promise<string> {
    const thought = args.thought as string;
    console.log(`[DEBUG] [Tool: InternalMonologue] Character ${character.config.name} is thinking: ${thought}`);
    
    // 更新角色的内存上下文（或者可以累加到短期记忆中）
    character.runtime_state.memory_context = thought;
    
    // 作为内部独白固化到 L1 记忆，以供下一轮 reAct 检索
    if (contextMessage) {
      character.memoryManager.addMessage(new DomainMessage({
        msg_id: uuidv4(),
        user_id: character.config.id,
        session_id: contextMessage.session_id,
        timestamp: Date.now(),
        payload: {
          role: 'assistant',
          content: [{ type: 'text', text: `(内心独白: ${thought})` }]
        }
      }));
    }
    
    return "已记入脑海。";
  }
}
