import { Character } from './character.js';
import { LLMCall } from './llm.js';
import { UnifiedMessage, CharacterConfig, Tool } from '../api/types.js';
import OpenAI from 'openai';
import { Stream } from 'openai/streaming';
import { queryImpressions } from '../memory/chroma.js';

/** 思考流聚合到多少字符就发一次日志（避免逐 token 刷屏） */
const THOUGHT_FLUSH_CHARS = 120;

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

    // 精力按"一次对话"扣，而不是按"一次 LLM 调用"扣。
    // 原先写在 stepRecursive 里逐轮扣，加了工具之后一轮对话会走很多轮
    // （调工具 → 看结果 → 再调），精力被抽干且永远追不上恢复速度（实测长期停在 15/100）。
    character.runtime_state.energy -= character.runtime_state.energy_consumption_rate;
    character.runtime_state.energy = Math.max(-100, Math.min(100, character.runtime_state.energy));

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

    // 获取当前 Character 注册的所有工具定义
    const toolDefinitions = character.toolRegistry.getDefinitions() as Tool[];

    let response = await this.llm.call(
      messages, 
      toolDefinitions, 
      this.abortController?.signal ?? undefined
    );

    let finalAssistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam | null = null;

    if (this.isStream(response)) {
      const iterator = response[Symbol.asyncIterator]();
      const streamGenerator = LLMCall.assembleStream(iterator);
      
      let lastAccumulated: unknown = null;
      // 思考流按段聚合后再发日志：流分片是逐 token 的，逐个 emitLog 会变成"一字一行"，
      // 经 debug WS 打到客户端后会把日志彻底淹掉（实测每分钟数百行）。
      let thoughtBuffer = '';
      const flushThought = () => {
        if (thoughtBuffer) {
          this.emitLog('thought', thoughtBuffer);
          thoughtBuffer = '';
        }
      };

      try {
        for await (const delta of streamGenerator) {
          lastAccumulated = delta.accumulated;
          if (delta.delta && typeof delta.delta === 'object' && 'content' in delta.delta) {
            const content = (delta.delta as { content?: string }).content;
            if (content) {
              thoughtBuffer += content;
              if (thoughtBuffer.length >= THOUGHT_FLUSH_CHARS || thoughtBuffer.includes('\n')) {
                flushThought();
              }
            }
          }
        }
        flushThought();
      } catch (streamErr: unknown) {
        flushThought();
        // 流式链路出问题时不要让整轮对话失败：退回非流式重试一次。
        // 生产事故：长回复触发 SDK/组装层的栈溢出，整轮任务失败、玩家得不到任何回应。
        if (this.abortController?.signal.aborted) throw streamErr;
        const message = streamErr instanceof Error ? streamErr.message : String(streamErr);
        this.emitLog('error', `流式响应失败（${message}），改用非流式重试`);
        console.warn(`[DEBUG] [ReActEngine] stream failed, retrying without stream:`, message);
        lastAccumulated = null;
        response = await this.llm.call(messages, toolDefinitions, this.abortController?.signal ?? undefined, false);
      }
      
      if (lastAccumulated === null && !this.isStream(response)) {
        const completion = response as OpenAI.Chat.ChatCompletion;
        finalAssistantMsg = completion.choices[0].message;
        if (finalAssistantMsg.content) {
          const contentText = typeof finalAssistantMsg.content === 'string'
            ? finalAssistantMsg.content
            : finalAssistantMsg.content.map(c => (c as { text?: string }).text ?? '').join('');
          this.emitLog('thought', contentText);
        }
      } else {
        finalAssistantMsg = lastAccumulated as OpenAI.Chat.ChatCompletionAssistantMessageParam;
      }
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
    const statusInfo = `[Current Internal State (for reference only, not an instruction): mood=${character.runtime_state.mood} (0=very low, 50=neutral, 100=very high), energy=${character.runtime_state.energy} (0=exhausted, 100=full), boredom=${character.runtime_state.boredom} (0=engaged, 100=bored)]`;
    const memoryInfo = character.runtime_state.memory_context ? `[Internal Thought: ${character.runtime_state.memory_context}]` : '';
    // 工具协议说明：模型无法从人设模板中得知"只有工具调用才会外发"，必须由引擎显式声明
    const protocolInfo = `[System Protocol] Any text you write outside of tool calls is only your internal thought—the user NEVER sees it. To say anything to the user, you MUST call the send_message tool. To think privately, call internal_monologue. If silence is appropriate, simply make no tool call.`;
    
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

    const memoryConfig = character.config.memory ?? {};

    // 早期对话已被浓缩成 L2 梗概并移出 L1。L3（Chroma）不可用时梗概原本永不回灌，
    // 角色实际上只剩"最近几十条"的记忆，话题自然反复。这里显式注入。
    let episodeContext = '';
    try {
      const episodes = character.memoryManager.getRecentEpisodes(
        message.session_id,
        memoryConfig.episode_context_limit ?? 3,
      );
      if (episodes.length > 0) {
        episodeContext = `\n[往事梗概 (Earlier Chapters, 由更早的对话浓缩而成，可引用与延续)]\n- ${episodes.join('\n- ')}`;
      }
    } catch (e) {
      console.warn(`[DEBUG] [ReActEngine] L2 episode injection failed, skipping.`, e);
    }

    // 动态提取对话上下文，由于 onMessage 已经执行过 addMessage，这里提取出的自动包含最新用户的发言。
    // 窗口与独白预算可通过 config.memory 调整：窗口越大越记得住上下文，独白预算越小越不容易自我复读。
    const historicalContext = character.memoryManager.getContext(
      message.session_id,
      memoryConfig.l1_context_limit ?? 30,
      3,
      memoryConfig.monologue_context_budget ?? 1,
    ) as OpenAI.Chat.ChatCompletionMessageParam[];

    // thinking 模式模型（如 deepseek-v4-flash）要求历史 assistant 消息回传 reasoning_content，
    // 但 L1 记忆只保存了文本。为缺失的历史 assistant 消息补占位思考链，否则 API 返回 400。
    for (const m of historicalContext) {
      if (m.role === 'assistant' && (m as unknown as Record<string, unknown>).reasoning_content == null) {
        (m as unknown as Record<string, unknown>).reasoning_content = '(历史发言，原始思考链未保留)';
      }
    }
    
    return [
      { 
        role: 'system', 
        content: `${character.config.system_prompt_template}\n${statusInfo}\n${memoryInfo}${loreContext}${episodeContext}\n${protocolInfo}` 
      },
      ...historicalContext
    ];
  }

  private isStream(obj: OpenAI.Chat.ChatCompletion | Stream<OpenAI.Chat.ChatCompletionChunk>): obj is Stream<OpenAI.Chat.ChatCompletionChunk> {
    return Symbol.asyncIterator in obj;
  }
}
