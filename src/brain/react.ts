import { Character } from './character.js';
import { LLMCall } from './llm.js';
import { UnifiedMessage, CharacterConfig, Tool } from '../api/types.js';
import OpenAI from 'openai';
import { Stream } from 'openai/streaming';
import { queryImpressions } from '../memory/chroma.js';

export type ReActLogEntry = {
  type: 'thought' | 'action' | 'observation' | 'error' | 'status';
  content: string;
  timestamp: number;
};

export class ReActEngine {
  private config: CharacterConfig;
  private llm: LLMCall;
  private abortController: AbortController | null = null;
  private currentTask: Promise<void> | null = null;
  private maxSteps: number = 10;
  
  // 日志回调函数
  public onLog?: (entry: ReActLogEntry) => void;

  constructor(config: CharacterConfig) {
    this.config = config;
    this.llm = new LLMCall(config);
  }

  private emitLog(type: ReActLogEntry['type'], content: string) {
    const entry: ReActLogEntry = { type, content, timestamp: Date.now() };
    console.log(`[RE-ACT LOG][${type.toUpperCase()}] ${content}`);
    this.onLog?.(entry);
  }

  /**
   * 物理级中断当前正在运行的任务
   */
  public kill(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * 启动 reAct 循环
   */
  public async run(character: Character, message: UnifiedMessage): Promise<void> {
    if (this.currentTask) {
      console.log(`[DEBUG] [ReActEngine] Interrupting existing task for ${character.config.name}`);
      this.kill();
      try {
        await this.currentTask;
      } catch (err: unknown) {
        // 忽略中断产生的错误
      }
    }

    this.currentTask = this.execute(character, message);
    
    try {
      await this.currentTask;
    } finally {
      this.currentTask = null;
    }
  }

  /**
   * 实际执行逻辑
   */
  private async execute(character: Character, message: UnifiedMessage): Promise<void> {
    this.abortController = new AbortController();
    console.log(`[DEBUG] [ReActEngine] Executing loop for ${character.config.name}`);

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = await this.prepareContext(character, message);
      await this.stepRecursive(character, messages, 0, message);
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        console.log(`[DEBUG] [ReActEngine] Task for ${character.config.name} was aborted.`);
      } else {
        this.emitLog('error', `Task failed: ${error.message}`);
        console.error(`[DEBUG] [ReActEngine] Task error:`, error);
        throw error;
      }
    }
  }

  /**
   * 递归执行 reAct 步骤
   */
  private async stepRecursive(
    character: Character,
    messages: OpenAI.Chat.ChatCompletionMessageParam[], 
    stepCount: number,
    contextMessage: UnifiedMessage
  ): Promise<void> {
    if (stepCount >= this.maxSteps) {
      console.warn(`[DEBUG] [ReActEngine] Max steps reached.`);
      return;
    }

    if (this.abortController?.signal.aborted) {
      throw new Error('AbortError');
    }

    // 每一轮循环消耗精力，并限制在模型接受的 [-100, 100] 范围内
    character.runtime_state.energy -= character.runtime_state.energy_consumption_rate;
    character.runtime_state.energy = Math.max(-100, Math.min(100, character.runtime_state.energy));

    // 获取当前 Character 注册的所有工具定义
    const toolDefinitions = character.toolRegistry.getDefinitions() as Tool[];

    const response = await this.llm.call(
      messages, 
      toolDefinitions, 
      this.abortController?.signal ?? undefined
    );

    let finalAssistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam | null = null;

    if (this.isStream(response)) {
      const iterator = response[Symbol.asyncIterator]();
      const streamGenerator = LLMCall.assembleStreamRecursive(iterator);
      
      let lastAccumulated: unknown = null;

      for await (const delta of streamGenerator) {
        lastAccumulated = delta.accumulated;
        if (delta.delta && typeof delta.delta === 'object' && 'content' in delta.delta) {
          const content = (delta.delta as { content?: string }).content;
          if (content) this.emitLog('thought', content);
        }
      }
      
      finalAssistantMsg = lastAccumulated as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    } else {
      const completion = response as OpenAI.Chat.ChatCompletion;
      finalAssistantMsg = completion.choices[0].message;
      if (finalAssistantMsg.content) {
        const contentText = typeof finalAssistantMsg.content === 'string'
          ? finalAssistantMsg.content
          : finalAssistantMsg.content.map(c => (c as { text?: string }).text ?? '').join('');
        this.emitLog('thought', contentText);
      }
    }

    if (finalAssistantMsg) {
      messages.push(finalAssistantMsg);
      if (finalAssistantMsg.tool_calls && finalAssistantMsg.tool_calls.length > 0) {
        await this.handleToolCalls(character, finalAssistantMsg.tool_calls, messages, stepCount, contextMessage);
      }
    }
  }

  private async handleToolCalls(
    character: Character,
    toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    stepCount: number,
    contextMessage: UnifiedMessage
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments;

      this.emitLog('action', `Executing ${toolName}...`);
      
      const tool = character.toolRegistry.get(toolName);
      let observation: string;

      if (tool) {
        try {
          const parsedArgs = JSON.parse(toolArgs) as Record<string, unknown>;
          observation = await tool.execute(parsedArgs, character, contextMessage);
        } catch (err: unknown) {
          observation = `Error executing tool ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        observation = `Error: Tool ${toolName} not found in registry.`;
      }

      this.emitLog('observation', observation);
      
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: observation
      });
    }

    // 只要有工具调用发生，就继续下一轮迭代（除非被 kill）
    await this.stepRecursive(character, messages, stepCount + 1, contextMessage);
  }

  private async prepareContext(character: Character, message: UnifiedMessage): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const statusInfo = `[Current Status: Mood=${character.runtime_state.mood}, Energy=${character.runtime_state.energy}, Boredom=${character.runtime_state.boredom}]`;
    const memoryInfo = character.runtime_state.memory_context ? `[Internal Thought: ${character.runtime_state.memory_context}]` : '';
    
    // 提取当前用户的文本输入作为向量检索的 Query
    const queryStr = Array.isArray(message.payload.content)
      ? message.payload.content.map(c => c.type === 'text' ? c.text : '').join(' ')
      : message.payload.content;
      
    // 异步检索相关长期印象 (L3)
    let loreContext = '';
    try {
      const impressions = await queryImpressions(character.config.id, message.session_id, queryStr);
      if (impressions.length > 0) {
        loreContext = `\n[长期印象 (Long-term Memory)]\n- ${impressions.join('\n- ')}`;
      }
    } catch (e) {
      // 容错处理：若 Chroma 未启动不应阻塞核心链路
      console.warn(`[DEBUG] [ReActEngine] ChromaDB query failed, skipping L3 memory injection.`);
    }
    
    // 动态提取对话上下文，由于 onMessage 已经执行过 addMessage，这里提取出的自动包含最新用户的发言。
    const historicalContext = character.memoryManager.getContext(message.session_id) as OpenAI.Chat.ChatCompletionMessageParam[];
    
    return [
      { 
        role: 'system', 
        content: `${character.config.system_prompt_template}\n${statusInfo}\n${memoryInfo}${loreContext}` 
      },
      ...historicalContext
    ];
  }

  private isStream(obj: OpenAI.Chat.ChatCompletion | Stream<OpenAI.Chat.ChatCompletionChunk>): obj is Stream<OpenAI.Chat.ChatCompletionChunk> {
    return Symbol.asyncIterator in obj;
  }
}
