import axios from 'axios';
import OpenAI from 'openai';
import { BaseTool } from './base.js';
import { Character } from '../character.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { Message as DomainMessage } from '../../memory/Message.js';
import { v4 as uuidv4 } from 'uuid';

export class SendMessageTool extends BaseTool {
  public readonly definition: OpenAI.Chat.ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'send_message',
      description: '发送一条消息给用户。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '消息的具体内容'
          }
        },
        required: ['content']
      }
    }
  };

  public async execute(
    args: Record<string, unknown>, 
    character: Character, 
    contextMessage?: import('../../api/types.js').UnifiedMessage
  ): Promise<string> {
    const content = args.content as string;
    const { send_url, send_headers } = character.config.connection;

    console.log(`[DEBUG] [Tool: SendMessage] Sending to ${send_url}`);

    try {
      // 没有任何解析逻辑，直接透传对象给 axios，就像 Python 的 requests 一样
      await axios.post(send_url, {
        content: content,
      }, { 
        headers: send_headers 
      });
      
      // 持久化 Agent 的回复到记忆中
      if (contextMessage) {
        MemoryManager.addMessage(new DomainMessage({
          msg_id: uuidv4(),
          user_id: character.config.id,
          session_id: contextMessage.session_id,
          timestamp: Date.now(),
          payload: {
            role: 'assistant',
            content: [{ type: 'text', text: content }]
          }
        }));
      }

      return "消息发送成功。";
    } catch (error) {
      console.error(`[DEBUG] [Tool: SendMessage] Failed:`, error);
      return `发送失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
