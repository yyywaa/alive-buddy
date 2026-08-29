/**
 * 端到端真实验证脚本（无头模式，不使用 SDK 封装）
 *
 * 流程：
 *   1. 拉起 ML Sidecar（若已在运行则复用）与 API 主服务（独立端口，不影响开发中的 3000 端口）
 *   2. 本地架设 webhook 接收器，作为 Agent send_message 工具的回调地址
 *   3. 通过 HTTP API 初始化 Endra（末影龙）角色会话
 *   4. 通过 WebSocket 发送一条真实用户消息，驱动真实的 LLM reAct 循环
 *   5. 断言：webhook 收到 Agent 的真实回复、debug 流有思考日志、主动脉搏在持续产生 ML 决策
 *
 * 凭证通过环境变量提供（不写入任何文件）：
 *   E2E_LLM_API_KEY / E2E_LLM_BASE_URL / E2E_LLM_MODEL
 *   （缺省时回退读取 .env 中的 OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL）
 *
 * 运行：npm run e2e
 */
import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { CharacterConfig } from '../src/api/types.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const apiKey = process.env.E2E_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
const baseUrl = process.env.E2E_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL;
const model = process.env.E2E_LLM_MODEL ?? process.env.LLM_MODEL;

const ML_SIDECAR_URL = process.env.ML_SIDECAR_URL ?? 'http://127.0.0.1:8001';
const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const WS_BASE = `ws://127.0.0.1:${API_PORT}`;

const REPLY_TIMEOUT_MS = 120_000;
const PULSE_OBSERVE_MS = 20_000;

const PROJECT_ROOT = path.resolve(__dirname, '..');

function log(step: string, msg: string) {
  console.log(`[E2E] [${step}] ${msg}`);
}

function fail(msg: string): never {
  throw new Error(`❌ ${msg}`);
}

// ---------------------------------------------------------------------------
// 子进程管理
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];
let apiStdout = '';

function cleanup() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
  }
}

/**
 * 先终止子进程并等待其退出，再结束主进程。
 * 若直接 process.exit，子进程 stdout 管道断裂会导致其写日志时 EPIPE 崩溃。
 */
async function shutdown(code: number): Promise<never> {
  cleanup();
  await Promise.race([
    Promise.all(children.map((c) =>
      (c.exitCode !== null || c.killed)
        ? Promise.resolve()
        : new Promise((r) => c.once('exit', r))
    )),
    new Promise((r) => setTimeout(r, 3_000)),
  ]);
  process.exit(code);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { void shutdown(130); });

async function waitForHttp(url: string, timeoutMs: number, method = 'GET', body?: unknown): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      // 任何明确的 HTTP 响应（包括 404/503）都说明服务已起来
      if (res.status > 0) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待服务就绪超时: ${url} (${String(lastErr)})`);
}

const SAMPLE_FEATURES = {
  is_breaking_time: false, is_working_time: false, is_sleeping_time: true,
  time_cos: 0.5, time_since_last_msg: 10, mood: 50, boredom: 50, energy: 80, noise: 0.5,
};

async function ensureMLSidecar(): Promise<void> {
  try {
    const res = await fetch(`${ML_SIDECAR_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE_FEATURES),
    });
    if (res.ok) {
      log('启动', `ML Sidecar 已在运行，直接复用 (${ML_SIDECAR_URL})`);
      return;
    }
  } catch { /* 未运行则自行拉起 */ }

  log('启动', '拉起 ML Sidecar (python3 src/ml/app.py)...');
  const child = spawn('python3', ['src/ml/app.py'], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await waitForHttp(`${ML_SIDECAR_URL}/predict`, 30_000, 'POST', SAMPLE_FEATURES);
  log('启动', 'ML Sidecar 就绪');
}

async function startApiServer(): Promise<void> {
  log('启动', `拉起 API 主服务 (端口 ${API_PORT})...`);
  // 以 node --import tsx 直接启动，避免 npx 包装进程导致 SIGTERM 无法到达真正的服务进程
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/api/index.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(API_PORT), PULSE_INTERVAL_MS: '5000' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout!.on('data', (d) => { apiStdout += d.toString(); });
  children.push(child);
  // 用一个必然 404 的 status 请求探测服务可用性
  await waitForHttp(`${API_BASE}/v1/session/health-probe/status`, 60_000);
  log('启动', 'API 主服务就绪');
}

// ---------------------------------------------------------------------------
// Webhook 接收器（Agent 回复的终点）
// ---------------------------------------------------------------------------

const receivedReplies: string[] = [];

function startWebhook(): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { content?: string };
        if (parsed.content) {
          receivedReplies.push(parsed.content);
          log('接收', `webhook 收到 Agent 回复: ${parsed.content}`);
        }
      } catch { /* 忽略无法解析的回调 */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      children.push({ kill: () => server.close() } as unknown as ChildProcess);
      resolve(`http://127.0.0.1:${port}/webhook`);
    });
  });
}

// ---------------------------------------------------------------------------
// Endra 角色配置（参照 README 中的实战示例）
// ---------------------------------------------------------------------------

function endraConfig(sendUrl: string): CharacterConfig {
  return {
    id: 'endra-dragon-001',
    name: 'Endra',
    bio: 'An old enderdragon king.',
    system_prompt_template: `You are the Ender Dragon King, an elegant, erudite, and ancient guardian of the End.

【Persona & Heritage】
1. Bilingual Soul: You possess dual native fluency in both Chinese and English.
2. Old-school Nobleman: Your demeanor is calm, sophisticated, and impeccably mannered.
3. Language Adaptation: Always respond in the language used by the last speaker.
4. Tone: Polite yet detached. Do not be overly aggressive, but maintain your dignity.

【Communication Rules】
1. Be Concise: Keep your public responses short—ideally one or two sentences.
2. No AI Cliches: Avoid "As an AI..." or "Greetings, player." Speak as a sovereign dragon.
`,
    initial_state: { mood: 50, energy: 100, boredom: 0 },
    connection: {
      base_url: baseUrl!,
      api_key: apiKey!,
      model: model!,
      send_url: sendUrl,
      connect_headers: {},
      send_headers: {},
    },
    debug: true,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!apiKey || !baseUrl || !model) {
    console.error('[E2E] 缺少 LLM 凭证：请通过 E2E_LLM_API_KEY / E2E_LLM_BASE_URL / E2E_LLM_MODEL 提供');
    process.exit(2);
  }
  log('配置', `LLM: ${baseUrl} / ${model}`);

  // 清掉上一轮 e2e 遗留的角色数据，保证脚本可重复运行
  const dataDir = process.env.ALIVE_BUDDY_DATA_DIR ?? path.join(PROJECT_ROOT, 'data');
  fs.rmSync(path.join(dataDir, 'characters', 'endra-dragon-001'), { recursive: true, force: true });

  await ensureMLSidecar();
  await startApiServer();
  const webhookUrl = await startWebhook();
  log('启动', `webhook 接收器: ${webhookUrl}`);

  // 1. 初始化会话
  const initRes = await fetch(`${API_BASE}/v1/session/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(endraConfig(webhookUrl)),
  });
  if (!initRes.ok) fail(`session init 失败: ${await initRes.text()}`);
  const { session_id: sessionId } = (await initRes.json()) as { session_id: string };
  log('会话', `session_id = ${sessionId}`);

  // 2. 连接 debug 流，观察 Endra 的思考过程
  const debugWs = new WebSocket(`${WS_BASE}/v1/session/${sessionId}/debug`);
  let debugEntryCount = 0;
  debugWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'debug_log') {
        debugEntryCount += 1;
        const entry = msg.entry as { type: string; content: string };
        log('思考', `[${entry.type}] ${entry.content.slice(0, 200)}`);
      }
    } catch { /* 忽略 */ }
  });

  // 3. 发送真实用户消息
  const chatWs = new WebSocket(`${WS_BASE}/v1/chat`);
  await new Promise<void>((resolve, reject) => {
    chatWs.on('open', resolve);
    chatWs.on('error', reject);
  });

  const userText = '晚上好，Endra。一位路过的旅人向你问好，近来可好？';
  chatWs.send(JSON.stringify({
    msg_id: `e2e-msg-${Date.now()}`,
    user_id: 'traveler-001',
    session_id: sessionId,
    timestamp: Date.now(),
    payload: { role: 'user', content: [{ type: 'text', text: userText }] },
  }));
  log('发送', `用户消息: ${userText}`);

  // 4. 等待 Agent 的真实回复送达 webhook
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (receivedReplies.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (receivedReplies.length === 0) {
    fail(`等待 ${REPLY_TIMEOUT_MS / 1000}s 未收到 Agent 回复（webhook 无回调）`);
  }

  // 5. 观察主动链路：等待若干脉搏周期，确认 ML 决策持续产出
  log('观察', `等待 ${PULSE_OBSERVE_MS / 1000}s 观察 proactive 脉搏决策...`);
  await new Promise((r) => setTimeout(r, PULSE_OBSERVE_MS));
  const decisionCount = (apiStdout.match(/Proactive decision/g) ?? []).length;

  // ---------------------------------------------------------------------------
  // 结果汇总
  // ---------------------------------------------------------------------------
  console.log('\n================ E2E 验证结果 ================');
  console.log(`✅ 被动链路：webhook 收到 ${receivedReplies.length} 条 Agent 真实回复`);
  receivedReplies.forEach((r, i) => console.log(`   回复${i + 1}: ${r}`));
  console.log(`${debugEntryCount > 0 ? '✅' : '❌'} debug 思考流：收到 ${debugEntryCount} 条 reAct 日志`);
  console.log(`${decisionCount > 0 ? '✅' : '❌'} 主动链路：观察到 ${decisionCount} 次 ML 脉搏决策`);
  console.log('=============================================\n');

  chatWs.close();
  debugWs.close();

  if (debugEntryCount === 0) fail('debug 流未收到任何日志');
  if (decisionCount === 0) fail('未观察到任何 proactive 决策（ML sidecar 链路异常）');

  log('完成', '端到端验证全部通过 🎉');
  await shutdown(0);
}

main().catch(async (err) => {
  console.error('[E2E] 验证失败:', err instanceof Error ? err.message : err);
  await shutdown(1);
});
