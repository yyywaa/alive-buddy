import { getDB, initSQLite } from './sqlite.js';
import { Message } from './Message.js';
import { LLMCall } from '../brain/llm.js';
import type { CharacterConfig } from '../api/types.js';
import { addImpression, queryImpressions } from './chroma.js';
import OpenAI from 'openai';

/**
 * 可持久化的运行状态字段子集（对应 runtime_states 表）
 */
export interface PersistedRuntimeState {
  mood: number;
  energy: number;
  boredom: number;
  last_interaction_at: number;
  is_active: boolean;
  last_state_update_at?: number;
  last_active_session_id?: string;
}

/**
 * 每个 Character 对应一个 MemoryManager 实例，
 * 管理该 Character 的 L1 感知层、L2 事件层，并负责向 L3 印象层写入。
 */
export class MemoryManager {
  private readonly characterId: string;
  private readonly db: ReturnType<typeof getDB>;

  constructor(characterId: string, dbPath?: string) {
    this.characterId = characterId;
    this.db = initSQLite(characterId, dbPath);
  }

  /**
   * 将新消息存入 L1 感知层 (Working Memory)
   * 如果消息包含多模态数据，会自动将其注册到 media_registry 索引表中。
   */
  addMessage(msg: Message) {
    const data = msg.data;

    // 使用事务保证一致性；INSERT OR IGNORE 使重复投递（重试/重连补发）幂等，不中断消息流
    const insertTx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO messages (msg_id, character_id, session_id, timestamp, payload) 
        VALUES (?, ?, ?, ?, ?)
      `).run(data.msg_id, this.characterId, data.session_id, data.timestamp, msg.toJSONString());

      // 如果包含媒体，则更新多模态索引
      if (msg.hasMedia()) {
        this.db.prepare(`
          INSERT OR IGNORE INTO media_registry (msg_id, character_id, session_id, timestamp)
          VALUES (?, ?, ?, ?)
        `).run(data.msg_id, this.characterId, data.session_id, data.timestamp);
      }
    });

    insertTx();
  }

  /**
   * 提取当前 Character 指定会话的上下文，并自动应用多模态降级逻辑（仅保留最后 N 张图片）。
   * @param sessionId 目标聊天室 ID
   * @param limit 感知层提取的消息条数上限
   * @param maxImages 允许在上下文中保留明文图片的最大数量
   */
  getContext(sessionId: string, limit: number = 20, maxImages: number = 3) {
    // 1. 找出该会话最新出现的 maxImages 张包含媒体的消息 ID
    const mediaRows = this.db.prepare(`
      SELECT msg_id FROM media_registry 
      WHERE character_id = ? AND session_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(this.characterId, sessionId, maxImages) as { msg_id: string }[];

    const recentMediaIds = new Set(mediaRows.map(row => row.msg_id));

    // 2. 从 messages 表提取最近的 L1 消息
    // 注意：ORDER BY timestamp DESC 是为了拿到最新，但提供给 LLM 时需要正序（从早到晚）
    const msgRows = this.db.prepare(`
      SELECT payload FROM messages
      WHERE character_id = ? AND session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(this.characterId, sessionId, limit) as { payload: string }[];

    msgRows.reverse();

    // 3. 反序列化并映射成 OpenAI Payload
    return msgRows.map(row => {
      const msg = Message.fromJSONString(row.payload);
      // O(1) 过滤：判断这根 msg_id 是否存在于最新图片许可名单里
      const keepImage = recentMediaIds.has(msg.data.msg_id);
      return msg.toOpenAIPayload(keepImage);
    });
  }

  /**
   * 持久化运行状态到 runtime_states 表（整行覆盖）
   */
  saveRuntimeState(state: PersistedRuntimeState): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO runtime_states
        (character_id, mood, energy, boredom, last_interaction_at, is_active, last_state_update_at, last_active_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.characterId,
      state.mood,
      state.energy,
      state.boredom,
      state.last_interaction_at,
      state.is_active ? 1 : 0,
      state.last_state_update_at ?? null,
      state.last_active_session_id ?? null
    );
  }

  /**
   * 读取持久化的运行状态；从未持久化过时返回 null
   */
  loadRuntimeState(): PersistedRuntimeState | null {
    const row = this.db.prepare(`
      SELECT * FROM runtime_states WHERE character_id = ?
    `).get(this.characterId) as {
      mood: number;
      energy: number;
      boredom: number;
      last_interaction_at: number | null;
      is_active: number;
      last_state_update_at: number | null;
      last_active_session_id: string | null;
    } | undefined;

    if (!row) return null;
    return {
      mood: row.mood,
      energy: row.energy,
      boredom: row.boredom,
      last_interaction_at: row.last_interaction_at ?? Date.now(),
      is_active: !!row.is_active,
      last_state_update_at: row.last_state_update_at ?? undefined,
      last_active_session_id: row.last_active_session_id ?? undefined,
    };
  }

  /**
   * 统计指定会话在 L1 感知层中的消息条数
   */
  getMessageCount(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE character_id = ? AND session_id = ?
    `).get(this.characterId, sessionId) as { count: number };
    return row.count;
  }

  /**
   * 获取"保留最新 keep 条消息"的切割时间戳：
   * 即第 keep+1 新（倒数）消息的 timestamp；消息不足 keep+1 条时返回 null
   */
  getCutoffTimestamp(sessionId: string, keep: number): number | null {
    const row = this.db.prepare(`
      SELECT timestamp FROM messages
      WHERE character_id = ? AND session_id = ?
      ORDER BY timestamp DESC
      LIMIT 1 OFFSET ?
    `).get(this.characterId, sessionId, keep) as { timestamp: number } | undefined;
    return row ? row.timestamp : null;
  }

  /**
   * 列出该 Character 出现过消息或事件的所有会话 ID
   */
  getSessionIds(): string[] {
    const rows = this.db.prepare(`
      SELECT session_id FROM messages WHERE character_id = ?
      UNION
      SELECT session_id FROM episodes WHERE character_id = ?
    `).all(this.characterId, this.characterId) as { session_id: string }[];
    return rows.map(r => r.session_id);
  }

  /**
   * 将过期消息从感知层物理剥离，并转化为 L2 剧情梗概存入 episodes 表。
   * 边界为闭区间：timestamp <= beforeTimestamp 的消息都会被总结
   * （避免同一毫秒内到达的消息被漏掉）。
   */
  async summarizeToEpisode(config: CharacterConfig, sessionId: string, beforeTimestamp: number): Promise<void> {
    // 1. 获取要剥离的消息（按时间正序排列）
    const msgRows = this.db.prepare(`
      SELECT msg_id, payload FROM messages
      WHERE character_id = ? AND session_id = ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(this.characterId, sessionId, beforeTimestamp) as { msg_id: string, payload: string }[];

    if (msgRows.length === 0) return;

    // 将内容展开为简单格式供大模型理解，强制图片降级为文字
    const chatLog = msgRows.map(row => {
      const msg = Message.fromJSONString(row.payload);
      const payload = msg.toOpenAIPayload(false);
      const textContent = Array.isArray(payload.content)
        ? payload.content.map(c => c.type === 'text' ? (c as any).text : '').join(' ')
        : payload.content;
      return `[${payload.role}]: ${textContent}`;
    }).join('\n');

    // 2. 调用大模型进行总结
    const llm = new LLMCall(config);
    const systemPrompt: OpenAI.Chat.ChatCompletionMessageParam = {
      role: 'system',
      content: '请将以下由于时间久远而离开活跃记忆区的历史对话，浓缩总结为一段连贯的“剧情梗概”。要求：重点保留用户对你的设定偏好、发生了什么核心事件、得出什么结论。保持客观陈述。'
    };
    const userPrompt: OpenAI.Chat.ChatCompletionMessageParam = {
      role: 'user',
      content: `以下是过期的对话日志：\n\n${chatLog}`
    };

    // 强制关闭 stream，等待完整总结结果
    const response = await llm.call([systemPrompt, userPrompt], undefined, undefined, false);
    const completion = response as OpenAI.Chat.ChatCompletion;
    const summary = completion.choices[0].message?.content || '无法生成总结';

    // 3. 事务操作：存入 episodes 并物理删除已总结的 L1 消息及其媒体索引
    const summaryTx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO episodes (character_id, session_id, summary, created_at)
        VALUES (?, ?, ?, ?)
      `).run(this.characterId, sessionId, summary, Date.now());

      const deleteStmt = this.db.prepare(`DELETE FROM messages WHERE msg_id = ?`);
      const deleteMediaStmt = this.db.prepare(`DELETE FROM media_registry WHERE msg_id = ?`);

      for (const row of msgRows) {
        deleteStmt.run(row.msg_id);
        deleteMediaStmt.run(row.msg_id);
      }
    });

    summaryTx();
    console.log(`[DEBUG] [MemoryManager] Summarized ${msgRows.length} messages into L2 for character ${this.characterId}, session ${sessionId}`);
  }

  /**
   * 睡眠期固化：将 L2 事件（episodes）提炼为 L3 长期印象（ChromaDB），并清理 L2。
   */
  async consolidateToSemantic(config: CharacterConfig, sessionId: string, beforeTimestamp: number): Promise<void> {
    // 1. 获取需要提炼的 L2 剧情梗概
    const episodes = this.db.prepare(`
      SELECT id, summary FROM episodes
      WHERE character_id = ? AND session_id = ? AND created_at <= ?
      ORDER BY created_at ASC
    `).all(this.characterId, sessionId, beforeTimestamp) as { id: number, summary: string }[];

    if (episodes.length === 0) return;

    const episodesText = episodes.map((ep, i) => `事件 ${i + 1}: ${ep.summary}`).join('\n');

    // 2. 调用大模型，将剧情梗概提炼为“绝对事实”或“长效结论”
    const llm = new LLMCall(config);
    const systemPrompt: OpenAI.Chat.ChatCompletionMessageParam = {
      role: 'system',
      content: '你是一个记忆提炼助手。请将以下一系列历史事件梗概，进一步浓缩提炼为几条“绝对事实”或“长期结论”。\n例如：“用户叫张三”、“用户喜欢猫”、“用户在一家IT公司工作”。每条事实占一行，不要废话，不要带有时间戳。'
    };
    const userPrompt: OpenAI.Chat.ChatCompletionMessageParam = {
      role: 'user',
      content: `以下是近期的剧情梗概：\n\n${episodesText}`
    };

    const response = await llm.call([systemPrompt, userPrompt], undefined, undefined, false);
    const completion = response as OpenAI.Chat.ChatCompletion;
    const resultContent = completion.choices[0].message?.content || '';

    // 假设大模型按行返回事实
    const facts = resultContent.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('无法'));

    // 3. 写入 ChromaDB 并在 SQLite 中删除旧的 Episodes
    for (const fact of facts) {
      try {
        await addImpression(this.characterId, sessionId, fact);
      } catch (e) {
        console.error(`[ERROR] Failed to insert fact to ChromaDB: ${fact}`, e);
        // 如果向量数据库写入失败，中止清理，以免记忆丢失
        return;
      }
    }

    const deleteTx = this.db.transaction(() => {
      const stmt = this.db.prepare(`DELETE FROM episodes WHERE id = ?`);
      for (const ep of episodes) {
        stmt.run(ep.id);
      }
    });

    deleteTx();
    console.log(`[DEBUG] [MemoryManager] Consolidated ${episodes.length} episodes into ${facts.length} L3 impressions for character ${this.characterId}, session ${sessionId}`);
  }
}
