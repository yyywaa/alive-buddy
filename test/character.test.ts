import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 在构造任何 Character 之前，将数据目录指向隔离位置，保证测试不污染仓库数据。
// 注意：ALIVE_BUDDY_DATA_DIR 在 initSQLite 调用时才读取，因此这里设置有效；
// ML_SIDECAR_URL 则是在 import 时读取，须由 npm test 脚本在进程启动前注入。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-buddy-character-test-'));
process.env.ALIVE_BUDDY_DATA_DIR = tmpDir;

import { Character } from '../src/brain/character.js';
import { closeSQLite } from '../src/memory/sqlite.js';
import { CharacterConfig, UnifiedMessage } from '../src/api/types.js';

let seq = 0;
const createdIds: string[] = [];

function makeConfig(): CharacterConfig {
  seq += 1;
  const id = `test-char-${seq}`;
  createdIds.push(id);
  return {
    id,
    name: `Test-${seq}`,
    bio: 'test',
    system_prompt_template: 'You are {{name}}.',
    initial_state: { mood: 50, energy: 50, boredom: 0 },
    connection: {
      base_url: 'http://127.0.0.1:1',
      api_key: 'sk-test',
      model: 'test-model',
      send_url: 'http://127.0.0.1:1',
      connect_headers: {},
      send_headers: {},
    },
  };
}

function makeMsg(sessionId: string, text: string, silent = false): UnifiedMessage {
  return {
    msg_id: `msg-${Math.random().toString(36).slice(2)}`,
    user_id: 'user-1',
    session_id: sessionId,
    timestamp: Date.now(),
    silent,
    payload: { role: 'user', content: [{ type: 'text', text }] },
  };
}

after(() => {
  for (const id of createdIds) closeSQLite(id);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('updateState 驱动状态自然演化：无聊度上升、精力恢复、心情回归中性', () => {
  const char = new Character(makeConfig());
  char.runtime_state.boredom = 0;
  char.runtime_state.energy = 0;
  char.runtime_state.mood = 80;
  // 模拟 10 分钟未更新
  char.runtime_state.last_state_update_at = Date.now() - 10 * 60 * 1000;

  char.updateState();

  // 无聊度线性上升 0.5/min * 10min
  assert.ok(Math.abs(char.runtime_state.boredom - 5) < 0.01, `boredom=${char.runtime_state.boredom}`);
  // 精力线性恢复 1.0/min * 10min
  assert.ok(Math.abs(char.runtime_state.energy - 10) < 0.01, `energy=${char.runtime_state.energy}`);
  // 心情从 80 向 50 回落
  assert.ok(char.runtime_state.mood < 80 && char.runtime_state.mood > 50, `mood=${char.runtime_state.mood}`);
});

test('onMessage 静默消息只写记忆，不触发 reAct 循环', async () => {
  const char = new Character(makeConfig());
  let reactCalled = false;
  char.react.run = async () => { reactCalled = true; };

  char.runtime_state.boredom = 42;
  await char.onMessage(makeMsg('sess-1', '偷偷记住这句话', true));

  assert.equal(reactCalled, false);
  assert.equal(char.runtime_state.boredom, 0); // 收到消息无聊度归零
  assert.equal(char.runtime_state.last_active_session_id, 'sess-1');

  const context = char.memoryManager.getContext('sess-1') as Array<{ content: Array<{ text?: string }> }>;
  assert.equal(context.length, 1);
  assert.equal(context[0].content[0].text, '偷偷记住这句话');
});

test('onMessage 普通消息触发 reAct 循环', async () => {
  const char = new Character(makeConfig());
  let reactCalled = 0;
  char.react.run = async () => { reactCalled += 1; };

  await char.onMessage(makeMsg('sess-1', '你好'));

  assert.equal(reactCalled, 1);
});

test('pulse 在无活跃会话时直接跳过', async () => {
  const char = new Character(makeConfig());
  const result = await char.pulse();

  assert.equal(result?.action, 'none');
  assert.equal((result?.payload as { reason: string }).reason, 'no_active_session');
});

test('pulse 在 ML sidecar 不可用时优雅降级为主动放弃', async () => {
  const char = new Character(makeConfig());
  char.react.run = async () => { throw new Error('不应进入 reAct 循环'); };

  await char.onMessage(makeMsg('sess-1', '建立会话', true));
  const result = await char.pulse();

  assert.equal(result?.action, 'none');
  assert.match((result?.payload as { reason: string }).reason, /unavailable/);
});
