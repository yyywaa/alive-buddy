import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RemoteTool } from '../src/brain/tools/remote.js';
import { ToolRegistry } from '../src/brain/tools/index.js';
import type { CharacterConfig, Tool } from '../src/api/types.js';
import type { Character } from '../src/brain/character.js';

/** 起一个假的客户端工具端点，记录收到的请求 */
function startToolServer(handler: (body: unknown) => { status: number; payload: unknown }) {
  const received: Array<{ name?: string; args?: unknown; token?: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { name?: string; arguments?: unknown };
      received.push({ name: body.name, args: body.arguments, token: req.headers['x-tool-token'] as string | undefined });
      const { status, payload } = handler(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise<{ url: string; received: typeof received; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/tools/call`,
        received,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

function makeCharacter(toolUrl: string, sendHeaders: Record<string, string> = {}): Character {
  const config = {
    id: 'test',
    name: 'Endra',
    bio: 'test',
    system_prompt_template: '',
    initial_state: {},
    connection: {
      base_url: 'http://127.0.0.1:1',
      api_key: 'x',
      model: 'test',
      send_url: 'http://127.0.0.1:1/webhook',
      connect_headers: {},
      send_headers: sendHeaders,
      tool_url: toolUrl,
    },
  } as unknown as CharacterConfig;
  return { config } as unknown as Character;
}

const definition: Tool = {
  type: 'function',
  function: {
    name: 'moegirl_page',
    description: '读取条目摘要',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
};

const servers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of servers) await close();
});

test('RemoteTool 把 name/arguments 发到客户端并把返回内容作为 observation', async () => {
  const srv = await startToolServer(body => ({
    status: 200,
    payload: { ok: true, content: `萌娘百科《初音未来》开头：…（收到 ${JSON.stringify(body)}）` },
  }));
  servers.push(srv.close);

  const tool = new RemoteTool(definition, srv.url);
  const observation = await tool.execute({ title: '初音未来' }, makeCharacter(srv.url));

  assert.match(observation, /萌娘百科《初音未来》/);
  assert.equal(srv.received.length, 1);
  assert.equal(srv.received[0].name, 'moegirl_page');
  assert.deepEqual(srv.received[0].args, { title: '初音未来' });
});

test('RemoteTool 带上客户端提供的鉴权头', async () => {
  const srv = await startToolServer(() => ({ status: 200, payload: { content: 'ok' } }));
  servers.push(srv.close);

  const character = makeCharacter(srv.url, { 'X-Tool-Token': 'secret' });
  await new RemoteTool(definition, srv.url).execute({ title: 'x' }, character);

  assert.equal(srv.received[0].token, 'secret');
});

test('客户端报错时降级为可读文本而不是抛异常', async () => {
  const srv = await startToolServer(() => ({ status: 500, payload: { ok: false } }));
  servers.push(srv.close);

  const observation = await new RemoteTool(definition, srv.url).execute({ title: 'x' }, makeCharacter(srv.url));
  assert.match(observation, /调用失败/);
  assert.match(observation, /承认查不到/);
});

test('没有 tool_url 时给出明确提示', async () => {
  const observation = await new RemoteTool(definition, '').execute({ title: 'x' }, makeCharacter(''));
  assert.match(observation, /未提供 tool_url/);
});

test('返回体缺少 content 时不算成功但也不崩', async () => {
  const srv = await startToolServer(() => ({ status: 200, payload: { ok: true } }));
  servers.push(srv.close);

  const observation = await new RemoteTool(definition, srv.url).execute({}, makeCharacter(srv.url));
  assert.match(observation, /没有返回内容/);
});

test('ToolRegistry 用 extend_tool_list 注册扩展工具，且保留内置工具', () => {
  const config = {
    connection: { tool_url: 'http://127.0.0.1:1/tools/call' },
    extend_tool_list: [
      definition,
      { type: 'function', function: { name: 'send_message', description: '冲突', parameters: {} } },
    ],
  } as unknown as CharacterConfig;

  const registry = new ToolRegistry(config);
  const names = registry.getDefinitions().map(d => d.function.name);

  assert.ok(names.includes('moegirl_page'), '扩展工具应被注册');
  assert.ok(names.includes('send_message'), '内置工具应保留');
  assert.equal(registry.get('moegirl_page') instanceof RemoteTool, true);
  // 与内置同名的扩展工具应被跳过、不覆盖内置实现
  assert.equal(registry.get('send_message') instanceof RemoteTool, false);
});

test('没有扩展工具时注册表行为不变', () => {
  const registry = new ToolRegistry({ connection: {} } as unknown as CharacterConfig);
  const names = registry.getDefinitions().map(d => d.function.name).sort();
  assert.deepEqual(names, ['internal_monologue', 'send_message', 'set_mood']);
});
