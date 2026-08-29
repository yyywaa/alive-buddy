import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';

// ALIVE_BUDDY_DATA_DIR 在 initSQLite 调用时才读取，这里设置有效
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-buddy-trigger-test-'));
process.env.ALIVE_BUDDY_DATA_DIR = tmpDir;

import { Character } from '../src/brain/character.js';
import { closeSQLite, getDB } from '../src/memory/sqlite.js';
import { CharacterConfig, UnifiedMessage } from '../src/api/types.js';

// ---------------------------------------------------------------------------
// stub LLM：总结/提炼请求统一返回固定文本
// ---------------------------------------------------------------------------

const STUB_REPLY = '梗概：用户与角色闲聊。\n用户喜欢猫';

const stubLLM = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: STUB_REPLY },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

let llmBase: string;
const createdIds: string[] = [];

function makeConfig(id: string, memory?: CharacterConfig['memory']): CharacterConfig {
  createdIds.push(id);
  return {
    id,
    name: id,
    bio: 'trigger test',
    system_prompt_template: 'You are {{name}}.',
    initial_state: { mood: 50, energy: 100, boredom: 0 },
    connection: {
      base_url: llmBase,
      api_key: 'sk-stub',
      model: 'stub-model',
      send_url: 'http://127.0.0.1:1',
      connect_headers: {},
      send_headers: {},
    },
    memory,
  };
}

function silentMsg(sessionId: string, text: string, timestamp: number): UnifiedMessage {
  return {
    msg_id: `msg-${text}-${timestamp}`,
    user_id: 'user-1',
    session_id: sessionId,
    timestamp,
    silent: true,
    payload: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function countRows(characterId: string, table: 'messages' | 'episodes'): number {
  const db = getDB(characterId);
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE character_id = ?`).get(characterId) as { c: number };
  return row.c;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  await new Promise<void>((resolve) => {
    stubLLM.listen(0, '127.0.0.1', () => resolve());
  });
  llmBase = `http://127.0.0.1:${(stubLLM.address() as AddressInfo).port}`;
});

after(() => {
  for (const id of createdIds) closeSQLite(id);
  stubLLM.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

test('容量触发：L1 超容量后最旧消息被异步总结为 L2，仅保留容量内的最新消息', async () => {
  const char = new Character(makeConfig('trigger-capacity', { l1_capacity: 2, idle_summarize_minutes: 99999 }));

  const base = Date.now();
  await char.onMessage(silentMsg('sess', '第一条', base));
  await char.onMessage(silentMsg('sess', '第二条', base + 1000));
  await char.onMessage(silentMsg('sess', '第三条', base + 2000));

  // 第三条入库后 count=3 > capacity=2，触发对最旧一条的异步总结
  await waitFor(() => countRows('trigger-capacity', 'episodes') === 1);

  assert.equal(countRows('trigger-capacity', 'messages'), 2);
  const context = char.memoryManager.getContext('sess') as Array<{ content: Array<{ text?: string }> }>;
  assert.deepEqual(context.map(c => c.content[0].text), ['第二条', '第三条']);
});

test('空闲触发：pulse 检测到对话空闲超阈值后总结 L1 → L2', async () => {
  const char = new Character(makeConfig('trigger-idle', { l1_capacity: 1000, idle_summarize_minutes: 0 }));
  char.react.run = async () => { /* 本测试不涉及 reAct 循环 */ };

  await char.onMessage(silentMsg('sess', '闲置前的对话', Date.now()));
  // 确保空闲时长超过 0 分钟阈值
  char.runtime_state.last_interaction_at = Date.now() - 1000;

  await char.pulse();

  await waitFor(() => countRows('trigger-idle', 'episodes') === 1);
  assert.equal(countRows('trigger-idle', 'messages'), 0);
});

test('L2→L3 固化在 ChromaDB 不可用时保留 episodes，不丢记忆', async () => {
  const config = makeConfig('trigger-consolidate', {});
  const char = new Character(config);

  // 直接播种一条 L2 事件
  const db = getDB('trigger-consolidate');
  db.prepare('INSERT INTO episodes (character_id, session_id, summary, created_at) VALUES (?, ?, ?, ?)')
    .run('trigger-consolidate', 'sess', '旧事件：用户提到过喜欢猫', 1000);

  // ChromaDB 未初始化，固化应安全中止且不清除 episodes
  await char.memoryManager.consolidateToSemantic(config, 'sess', Date.now());

  assert.equal(countRows('trigger-consolidate', 'episodes'), 1);
});

test('运行状态持久化：重建 Character 后从 SQLite 恢复状态', async () => {
  const config = makeConfig('trigger-persist', {});

  const char1 = new Character(config);
  char1.runtime_state.mood = 88;
  char1.runtime_state.last_active_session_id = 'sess-persist';
  char1.runtime_state.last_state_update_at = Date.now() - 60_000;
  char1.updateState(); // 演化一个周期并持久化
  const savedMood = char1.runtime_state.mood;
  const savedBoredom = char1.runtime_state.boredom;

  // 模拟进程重启：关闭数据库连接后以相同 config 重建
  closeSQLite('trigger-persist');
  const char2 = new Character(config);

  assert.equal(char2.runtime_state.mood, savedMood);
  assert.equal(char2.runtime_state.boredom, savedBoredom);
  assert.equal(char2.runtime_state.last_active_session_id, 'sess-persist');
});
