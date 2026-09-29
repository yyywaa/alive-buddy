import axios from 'axios';
import OpenAI from 'openai';
import { BaseTool } from './base.js';
import { Character } from '../character.js';
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

    // 双保险：这一轮若已被更新的消息取代（abort），就不要把过时的话发出去。
    // 工具执行发生在 abort 之后是可能的——LLM 已经把 tool_call 解析出来了。
    if (character.react?.isAborted?.()) {
      console.log('[DEBUG] [Tool: SendMessage] 本轮已中断，放弃发送过时发言');
      return '（本轮已被更新的消息取代，这条发言没有发出。）';
    }

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
        character.memoryManager.addMessage(new DomainMessage({
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
