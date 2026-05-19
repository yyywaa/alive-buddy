import { Character } from './character.js';
import { LLMCall } from './llm.js';
import { UnifiedMessage, CharacterConfig } from '../api/types.js';
import OpenAI from 'openai';
import { Stream } from 'openai/streaming';

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
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = this.prepareContext(character, message);
      await this.stepRecursive(character, messages, 0);
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
    stepCount: number
  ): Promise<void> {
    if (stepCount >= this.maxSteps) {
      console.warn(`[DEBUG] [ReActEngine] Max steps reached.`);
      return;
    }

    if (this.abortController?.signal.aborted) {
      throw new Error('AbortError');
    }

    // 每一轮循环消耗精力
    character.runtime_state.energy -= character.runtime_state.energy_consumption_rate;

    // 获取当前 Character 注册的所有工具定义
    const toolDefinitions = character.toolRegistry.getDefinitions();

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
        this.emitLog('thought', finalAssistantMsg.content);
      }
    }

    if (finalAssistantMsg) {
      messages.push(finalAssistantMsg);
      if (finalAssistantMsg.tool_calls && finalAssistantMsg.tool_calls.length > 0) {
        await this.handleToolCalls(character, finalAssistantMsg.tool_calls, messages, stepCount);
      }
    }
  }

  private async handleToolCalls(
    character: Character,
    toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    stepCount: number
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
          observation = await tool.execute(parsedArgs, character);
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
    await this.stepRecursive(character, messages, stepCount + 1);
  }

  private prepareContext(character: Character, message: UnifiedMessage): OpenAI.Chat.ChatCompletionMessageParam[] {
    const statusInfo = `[Current Status: Mood=${character.runtime_state.mood}, Energy=${character.runtime_state.energy}, Boredom=${character.runtime_state.boredom}]`;
    const memoryInfo = character.runtime_state.memory_context ? `[Internal Thought: ${character.runtime_state.memory_context}]` : '';
    
    return [
      { 
        role: 'system', 
        content: `${character.config.system_prompt_template}\n${statusInfo}\n${memoryInfo}` 
      },
      { 
        role: 'user', 
        content: Array.isArray(message.payload.content) 
          ? JSON.stringify(message.payload.content) 
          : message.payload.content 
      }
    ];
  }

  private isStream(obj: OpenAI.Chat.ChatCompletion | Stream<OpenAI.Chat.ChatCompletionChunk>): obj is Stream<OpenAI.Chat.ChatCompletionChunk> {
    return Symbol.asyncIterator in obj;
  }
}
