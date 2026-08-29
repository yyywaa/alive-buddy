import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-buddy-api-test-'));
process.env.ALIVE_BUDDY_DATA_DIR = tmpDir;

import { buildApp } from '../src/api/index.js';
import { CharacterConfig, UnifiedMessage } from '../src/api/types.js';

// ---------------------------------------------------------------------------
// 测试替身：OpenAI 兼容的 stub LLM 服务器与消息 webhook 接收器
// ---------------------------------------------------------------------------

const llmRequests: Array<{ model: string; messages: Array<{ role: string; content?: unknown }> }> = [];
let llmCallCount = 0;

/** 第一次调用返回 send_message 工具调用，后续调用返回纯文本以终止 reAct 循环 */
const stubLLM = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llmCallCount += 1;
    llmRequests.push(JSON.parse(body));

    const isFirst = llmCallCount === 1;
    const message = isFirst
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'send_message', arguments: JSON.stringify({ content: '你好，人类。' }) },
          }],
        }
      : { role: 'assistant', content: '（内心活动结束）' };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-${llmCallCount}`,
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [{ index: 0, message, finish_reason: isFirst ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

const webhookBodies: Array<{ content?: string }> = [];
const webhook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    webhookBodies.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

// ---------------------------------------------------------------------------
// 测试基础设施
// ---------------------------------------------------------------------------

let app: ReturnType<typeof buildApp>;
let apiBase: string;
let wsBase: string;
let llmBase: string;
let webhookUrl: string;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function makeConfig(id: string): CharacterConfig {
  return {
    id,
    name: 'ApiTestBot',
    bio: 'integration test bot',
    system_prompt_template: 'You are {{name}}.',
    initial_state: { mood: 50, energy: 100, boredom: 0 },
    connection: {
      base_url: llmBase,
      api_key: 'sk-stub',
      model: 'stub-model',
      send_url: webhookUrl,
      connect_headers: {},
      send_headers: {},
    },
    llm_setting: { stream: false },
    debug: true,
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

function connectWS(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextWSMessage(ws: WebSocket, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function initSession(config: CharacterConfig): Promise<string> {
  const res = await fetch(`${apiBase}/v1/session/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  const [llmPort, webhookPort] = await Promise.all([listen(stubLLM), listen(webhook)]);
  llmBase = `http://127.0.0.1:${llmPort}`;
  webhookUrl = `http://127.0.0.1:${webhookPort}/webhook`;

  // 脉搏间隔拉长到 1 小时，避免测试中触发主动链路
  app = buildApp({ pulseIntervalMs: 3_600_000, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  apiBase = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  stubLLM.close();
  webhook.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

test('session init 返回 session_id，status 可查状态、未知会话返回 404', async () => {
  const sessionId = await initSession(makeConfig('api-test-char-1'));

  const statusRes = await fetch(`${apiBase}/v1/session/${sessionId}/status`);
  assert.equal(statusRes.status, 200);
  const state = (await statusRes.json()) as { mood: number; energy: number; boredom: number };
  assert.equal(state.mood, 50);
  assert.equal(state.energy, 100);
  assert.equal(state.boredom, 0);

  const missing = await fetch(`${apiBase}/v1/session/no-such-session/status`);
  assert.equal(missing.status, 404);
});

test('WS 拒绝格式非法的消息与未知会话', async () => {
  const ws = await connectWS(`${wsBase}/v1/chat`);
  try {
    ws.send(JSON.stringify({ foo: 'bar' }));
    const err1 = await nextWSMessage(ws);
    assert.equal(err1.error, 'Invalid message format');

    ws.send(JSON.stringify(makeMsg('no-such-session', 'hi')));
    const err2 = await nextWSMessage(ws);
    assert.equal(err2.error, 'Session not found');
  } finally {
    ws.close();
  }
});

test('WS 静默消息写入记忆并返回回执，不触发 LLM', async () => {
  const sessionId = await initSession(makeConfig('api-test-char-2'));
  const llmCallsBefore = llmCallCount;

  const ws = await connectWS(`${wsBase}/v1/chat`);
  try {
    ws.send(JSON.stringify(makeMsg(sessionId, '静默上下文', true)));
    const ack = await nextWSMessage(ws);
    assert.ok(JSON.stringify(ack).includes('I received your message'));
  } finally {
    ws.close();
  }

  // 静默消息不应消耗 LLM 调用
  assert.equal(llmCallCount, llmCallsBefore);

  const statusRes = await fetch(`${apiBase}/v1/session/${sessionId}/status`);
  const state = (await statusRes.json()) as { last_active_session_id?: string };
  assert.equal(state.last_active_session_id, sessionId);
});

test('完整 reAct 回路：用户消息 → LLM 工具调用 → webhook 收到回复', async () => {
  const sessionId = await initSession(makeConfig('api-test-char-3'));
  const webhookCountBefore = webhookBodies.length;
  const llmCallsBefore = llmCallCount;

  const debugWs = await connectWS(`${wsBase}/v1/session/${sessionId}/debug`);
  const debugEntries: Array<{ type: string }> = [];
  debugWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'debug_log') debugEntries.push(msg.entry);
  });

  const chatWs = await connectWS(`${wsBase}/v1/chat`);
  try {
    chatWs.send(JSON.stringify(makeMsg(sessionId, '你好，测试机器人')));
    await nextWSMessage(chatWs); // 服务回执

    // Agent 应通过 send_message 工具将回复 POST 到 webhook
    await waitFor(() => webhookBodies.length > webhookCountBefore);
    assert.equal(webhookBodies[webhookBodies.length - 1].content, '你好，人类。');

    // reAct 循环应至少经历两轮 LLM 调用（工具调用 → 观察 → 收尾）
    await waitFor(() => llmCallCount >= llmCallsBefore + 2);
    const secondCall = llmRequests[llmCallsBefore + 1];
    const roles = secondCall.messages.map((m) => m.role);
    assert.ok(roles.includes('tool'), `第二轮请求应包含 tool 观察结果: ${roles}`);

    // debug 流应推送 action / observation 日志
    await waitFor(() => debugEntries.some((e) => e.type === 'action'));
    assert.ok(debugEntries.some((e) => e.type === 'observation'));
  } finally {
    chatWs.close();
    debugWs.close();
  }
});
