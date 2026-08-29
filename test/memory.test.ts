import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { Message } from '../src/memory/Message.js';
import { closeSQLite } from '../src/memory/sqlite.js';
import { UnifiedMessage } from '../src/api/types.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-buddy-memory-test-'));
const createdIds: string[] = [];

function makeManager(): MemoryManager {
  const id = `test-mem-${createdIds.length + 1}`;
  createdIds.push(id);
  return new MemoryManager(id, path.join(tmpDir, `${id}.db`));
}

function textMsg(id: string, sessionId: string, text: string, timestamp: number): Message {
  const data: UnifiedMessage = {
    msg_id: id,
    user_id: 'user-1',
    session_id: sessionId,
    timestamp,
    payload: { role: 'user', content: [{ type: 'text', text }] },
  };
  return new Message(data);
}

function imageMsg(id: string, sessionId: string, summary: string, timestamp: number): Message {
  const data: UnifiedMessage = {
    msg_id: id,
    user_id: 'user-1',
    session_id: sessionId,
    timestamp,
    payload: {
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: `https://example.com/${id}.png` }, summary },
      ],
    },
  };
  return new Message(data);
}

after(() => {
  for (const id of createdIds) closeSQLite(id);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getContext 按时间正序返回会话消息', () => {
  const mm = makeManager();
  mm.addMessage(textMsg('m3', 'sess', '第三条', 3000));
  mm.addMessage(textMsg('m1', 'sess', '第一条', 1000));
  mm.addMessage(textMsg('m2', 'sess', '第二条', 2000));

  const context = mm.getContext('sess') as Array<{ content: Array<{ text?: string }> }>;
  assert.deepEqual(
    context.map(c => c.content[0].text),
    ['第一条', '第二条', '第三条']
  );
});

test('getContext 在不同会话之间相互隔离', () => {
  const mm = makeManager();
  mm.addMessage(textMsg('a1', 'sess-a', '会话A', 1000));
  mm.addMessage(textMsg('b1', 'sess-b', '会话B', 1000));

  const contextA = mm.getContext('sess-a') as Array<{ content: Array<{ text?: string }> }>;
  assert.equal(contextA.length, 1);
  assert.equal(contextA[0].content[0].text, '会话A');
});

test('getContext 多模态降级：仅保留最后 3 张图片，更早的替换为文字描述', () => {
  const mm = makeManager();
  for (let i = 1; i <= 5; i++) {
    mm.addMessage(imageMsg(`img-${i}`, 'sess', `图片${i}的描述`, i * 1000));
  }

  const context = mm.getContext('sess', 20, 3) as Array<{
    content: Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }>;
  assert.equal(context.length, 5);

  // 最早的 2 张图片应被降级为文字描述
  for (const i of [0, 1]) {
    const imageBlock = context[i].content[1];
    assert.equal(imageBlock.type, 'text');
    assert.match(imageBlock.text!, /附加媒体/);
    assert.match(imageBlock.text!, new RegExp(`图片${i + 1}的描述`));
  }

  // 最新的 3 张图片保留原始 image_url 结构
  for (const i of [2, 3, 4]) {
    const imageBlock = context[i].content[1];
    assert.equal(imageBlock.type, 'image_url');
    assert.ok(imageBlock.image_url?.url);
  }
});

test('addMessage 重复投递同一 msg_id 幂等，不中断消息流', () => {
  const mm = makeManager();
  const msg = textMsg('dup-1', 'sess', '只应存一份', 1000);

  mm.addMessage(msg);
  assert.doesNotThrow(() => mm.addMessage(msg));

  const context = mm.getContext('sess') as Array<unknown>;
  assert.equal(context.length, 1);
});

test('runtime_state 保存与读取往返一致', () => {
  const mm = makeManager();
  const characterId = createdIds[createdIds.length - 1];

  assert.equal(mm.loadRuntimeState(), null);

  mm.saveRuntimeState({
    mood: 66,
    energy: 42,
    boredom: 7,
    last_interaction_at: 123,
    is_active: true,
    last_state_update_at: 456,
    last_active_session_id: 'sess-x',
  });

  const loaded = mm.loadRuntimeState();
  assert.equal(loaded?.mood, 66);
  assert.equal(loaded?.energy, 42);
  assert.equal(loaded?.boredom, 7);
  assert.equal(loaded?.is_active, true);
  assert.equal(loaded?.last_state_update_at, 456);
  assert.equal(loaded?.last_active_session_id, 'sess-x');

  // 覆盖写：第二次保存应整行替换而非新增
  mm.saveRuntimeState({
    mood: 10, energy: 20, boredom: 30,
    last_interaction_at: 999, is_active: false,
  });
  const updated = mm.loadRuntimeState();
  assert.equal(updated?.mood, 10);
  assert.equal(updated?.is_active, false);
  assert.equal(updated?.last_active_session_id, undefined);
});

test('Message.toOpenAIPayload 按 keepImage 决定图片保留或降级', () => {
  const msg = imageMsg('x', 'sess', '一只黑猫', 1000);

  const kept = msg.toOpenAIPayload(true);
  assert.equal(kept.content[1].type, 'image_url');

  const degraded = msg.toOpenAIPayload(false);
  assert.equal(degraded.content[1].type, 'text');
  assert.match((degraded.content[1] as { text: string }).text, /一只黑猫/);
});

test('Message 序列化与反序列化往返一致', () => {
  const msg = textMsg('rt-1', 'sess', '往返测试', 1234);
  const restored = Message.fromJSONString(msg.toJSONString());

  assert.equal(restored.data.msg_id, 'rt-1');
  assert.equal(restored.data.session_id, 'sess');
  assert.equal(restored.data.timestamp, 1234);
});
