import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { Message } from '../src/memory/Message.js';
import { closeSQLite } from '../src/memory/sqlite.js';
import { UnifiedMessage } from '../src/api/types.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-buddy-context-test-'));
const managers: MemoryManager[] = [];
const ids: string[] = [];

function makeManager(): MemoryManager {
  const id = `test-ctx-${ids.length + 1}`;
  ids.push(id);
  const manager = new MemoryManager(id, path.join(tmpDir, `${id}.db`));
  managers.push(manager);
  return manager;
}

function msg(partial: Partial<UnifiedMessage> & { text: string }): Message {
  const data: UnifiedMessage = {
    msg_id: `m-${Math.random().toString(36).slice(2)}`,
    user_id: 'user-1',
    session_id: 's1',
    timestamp: Date.now(),
    payload: { role: 'assistant', content: [{ type: 'text', text: partial.text }] },
    ...partial,
    // payload 显式覆盖，避免被上面的展开顺序影响
    ...(partial.payload ? { payload: partial.payload } : {}),
  };
  return new Message(data);
}

function textOf(payload: unknown): string {
  const p = payload as { content: Array<{ text?: string }> };
  return p.content.map(c => c.text ?? '').join(' ');
}

after(() => {
  for (const m of managers) {
    closeSQLite((m as unknown as { characterId: string })['characterId']);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('独白预算裁剪掉旧的自我嘀咕，但保留最新一条', () => {
  const manager = makeManager();
  const session = 's-monologue';

  for (let i = 0; i < 3; i++) {
    manager.addMessage(msg({
      text: `(内心独白: 第 ${i + 1} 段思考)`,
      session_id: session,
      payload: { role: 'assistant', content: [{ type: 'text', text: `(内心独白: 第 ${i + 1} 段思考)` }] },
    }));
  }
  manager.addMessage(msg({
    text: 'alice: 你好',
    session_id: session,
    payload: { role: 'user', content: [{ type: 'text', text: 'alice: 你好' }] },
  }));

  const withBudget = manager.getContext(session, 40, 3, 1).map(m => textOf(m));
  assert.equal(withBudget.filter(t => t.includes('内心独白')).length, 1, '只应保留最新一条独白');
  assert.ok(withBudget.some(t => t.includes('alice: 你好')), '真人消息必须保留');

  const unbudgeted = manager.getContext(session, 40, 3, -1).map(m => textOf(m));
  assert.equal(unbudgeted.filter(t => t.includes('内心独白')).length, 3, '-1 表示不裁剪');
});

test('L2 剧情梗概可以按时间正序读回', async () => {
  const manager = makeManager();
  const session = 's-episodes';

  for (let i = 0; i < 3; i++) {
    manager.addMessage(msg({
      text: `alice: 第 ${i + 1} 回合`,
      session_id: session,
      payload: { role: 'user', content: [{ type: 'text', text: `alice: 第 ${i + 1} 回合` }] },
    }));
    await new Promise(resolve => setTimeout(resolve, 2));
  }

  // 直接把早期消息浓缩成 L2（避免依赖真实 LLM 调用）
  const db = (manager as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
  db.prepare(`INSERT INTO episodes (character_id, session_id, summary, created_at) VALUES (?, ?, ?, ?)`)
    .run(ids[ids.length - 1], session, '第一段旧事', 1);
  db.prepare(`INSERT INTO episodes (character_id, session_id, summary, created_at) VALUES (?, ?, ?, ?)`)
    .run(ids[ids.length - 1], session, '第二段旧事', 2);

  const episodes = manager.getRecentEpisodes(session, 3);
  assert.deepEqual(episodes, ['第一段旧事', '第二段旧事'], '应按时间正序返回');
  assert.deepEqual(manager.getRecentEpisodes(session, 0), [], 'limit=0 表示关闭');
});

test('getRecentOwnLines 只返回真正的发言，且最新的在前', () => {
  const manager = makeManager();
  const session = 's-own-lines';

  const push = (text: string, role: 'assistant' | 'user') => {
    manager.addMessage(new Message({
      msg_id: `m-${Math.random().toString(36).slice(2)}`,
      user_id: role === 'assistant' ? 'endra' : 'alice',
      session_id: session,
      timestamp: Date.now(),
      payload: { role, content: [{ type: 'text', text }] },
    }));
  };

  push('第一句发言', 'assistant');
  push('(内心独白: 不该算作发言)', 'assistant');
  push('alice: 你在吗', 'user');
  push('第二句发言', 'assistant');

  const lines = manager.getRecentOwnLines(session, 3);
  assert.deepEqual(lines, ['第二句发言', '第一句发言']);
});


test('被中断的那一轮不得再执行工具（防止补发过时答案）', () => {
  const src = require('node:fs').readFileSync('src/brain/react.ts', 'utf8');
  assert.match(src, /本轮已被中断，跳过全部工具调用/, 'handleToolCalls 开头应检查 abort');
  assert.match(src, /跳过剩余工具/, '循环内每个工具执行前也应检查 abort');
  // 检查点必须在工具真正执行之前
  const abortIdx = src.indexOf('跳过剩余工具');
  const execIdx = src.indexOf('await tool.execute');
  assert.ok(abortIdx > 0 && execIdx > 0 && abortIdx < execIdx, 'abort 检查必须先于 tool.execute');
  assert.match(src, /isAborted\(\)/, '应暴露中断状态给工具层');

  const send = require('node:fs').readFileSync('src/brain/tools/send_message.ts', 'utf8');
  assert.match(send, /isAborted/, 'send_message 必须自己再兜一层：中断了就绝不外发');
});

test('轮次预算存在（工具额度 + 软时限）', () => {
  const src = require('node:fs').readFileSync('src/brain/react.ts', 'utf8');
  assert.match(src, /MAX_TOOL_CALLS_PER_TURN/);
  assert.match(src, /MAX_TURN_MS/);
  assert.match(src, /本轮工具额度已用完/);
  assert.match(src, /不要再调用工具/);
});
