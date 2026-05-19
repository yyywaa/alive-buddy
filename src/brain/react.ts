import { Character } from './character.js';
import { LLMCall, StreamDelta } from './llm.js';
import { UnifiedMessage, Tool } from '../api/types.js';
import OpenAI from 'openai';
import { Stream } from 'openai/streaming';

export type ReActLogEntry = {
  type: 'thought' | 'action' | 'observation' | 'error' | 'status';
  content: string;
  timestamp: number;
};

export class ReActEngine {
  private character: Character;
  private llm: LLMCall;
  private abortController: AbortController | null = null;
  private currentTask: Promise<void> | null = null;
  private maxSteps: number = 10;
  
  // 日志回调函数
  public onLog?: (entry: ReActLogEntry) => void;

  constructor(character: Character) {
    this.character = character;
    this.llm = new LLMCall(character.config);
  }

  private emitLog(type: ReActLogEntry['type'], content: string) {
    const entry: ReActLogEntry = { type, content, timestamp: Date.now() };
    console.log(`[RE-ACT LOG][${type.toUpperCase()}] ${content}`); // 依然保留控制台输出
    this.onLog?.(entry); // 同时触发回调给 UI/WebSocket
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
   * 使用 Promise 链式机制代替轮询，实现事件驱动的进程锁
   */
  public async run(message: UnifiedMessage): Promise<void> {
    // 1. 如果当前正在运行，执行 kill 并等待上一个任务任务结束
    if (this.currentTask) {
      console.log(`[DEBUG] [ReActEngine] Interrupting existing task for ${this.character.config.name}`);
      this.kill();
      try {
        await this.currentTask;
      } catch (err: unknown) {
        // 忽略中断产生的错误
      }
    }

    // 2. 创建新任务并记录到进程锁中
    this.currentTask = this.execute(message);
    
    try {
      await this.currentTask;
    } finally {
      this.currentTask = null;
    }
  }

  /**
   * 实际执行逻辑
   */
  private async execute(message: UnifiedMessage): Promise<void> {
    this.abortController = new AbortController();
    console.log(`[DEBUG] [ReActEngine] Executing loop for ${this.character.config.name}`);

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = this.prepareContext(message);
      await this.stepRecursive(messages, 0);
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        console.log(`[DEBUG] [ReActEngine] Task for ${this.character.config.name} was aborted.`);
      } else {
        console.error(`[DEBUG] [ReActEngine] Task error:`, error);
        throw error;
      }
    }
  }

  /**
   * 递归执行 reAct 步骤
   */
  private async stepRecursive(
    messages: OpenAI.Chat.ChatCompletionMessageParam[], 
    stepCount: number
  ): Promise<void> {
    if (stepCount >= this.maxSteps) {
      console.warn(`[DEBUG] [ReActEngine] Max steps reached.`);
      return;
    }

    // 检查中断信号
    if (this.abortController?.signal.aborted) {
      throw new Error('AbortError');
    }

    const response = await this.llm.call(
      messages, 
      this.character.config.extend_tool_list, 
      this.abortController?.signal ?? undefined
    );

    let finalAssistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam | null = null;

    if (this.isStream(response)) {
      const iterator = response[Symbol.asyncIterator]();
      const streamGenerator = LLMCall.assembleStreamRecursive(iterator);
      
      let lastAccumulated: unknown = null;

      for await (const delta of streamGenerator) {
        lastAccumulated = delta.accumulated;
        // 产出增量
        if (delta.content) {
          this.emitLog('thought', delta.content);
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
        await this.handleToolCalls(finalAssistantMsg.tool_calls, messages, stepCount);
      }
    }
  }

  private async handleToolCalls(
    toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    stepCount: number
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      this.emitLog('action', `Calling tool: ${toolCall.function.name} with args: ${toolCall.function.arguments}`);
      
      // TODO: 实现工具分发与执行
      const observation = `Observation from ${toolCall.function.name}`;
      this.emitLog('observation', observation);
      
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: observation
      });
    }

    await this.stepRecursive(messages, stepCount + 1);
  }

  private prepareContext(message: UnifiedMessage): OpenAI.Chat.ChatCompletionMessageParam[] {
    const statusInfo = `[Current Status: Mood=${this.character.runtime_state.mood}, Energy=${this.character.runtime_state.energy}]`;
    return [
      { role: 'system', content: `${this.character.config.system_prompt_template}\n${statusInfo}` },
      { role: 'user', content: JSON.stringify(message.payload.content) }
    ];
  }

  private isStream(obj: OpenAI.Chat.ChatCompletion | Stream<OpenAI.Chat.ChatCompletionChunk>): obj is Stream<OpenAI.Chat.ChatCompletionChunk> {
    return Symbol.asyncIterator in obj;
  }
}
