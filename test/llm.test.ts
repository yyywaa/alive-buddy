import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { LLMCall } from '../src/brain/llm.js';

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Chunk {
  return { choices: [{ delta, finish_reason: finishReason }] } as unknown as Chunk;
}

async function* fakeStream(chunks: Chunk[]): AsyncGenerator<Chunk> {
  for (const c of chunks) yield c;
}

async function assemble(chunks: Chunk[]) {
  const gen = LLMCall.assembleStreamRecursive(fakeStream(chunks)[Symbol.asyncIterator]());
  let lastAccumulated: any = null;
  let doneCount = 0;
  for await (const delta of gen) {
    lastAccumulated = delta.accumulated;
    if (delta.is_done) doneCount += 1;
  }
  return { lastAccumulated, doneCount };
}

test('assembleStreamRecursive 拼接流式文本增量', async () => {
  const { lastAccumulated, doneCount } = await assemble([
    chunk({ role: 'assistant', content: '你' }),
    chunk({ content: '好' }),
    chunk({ content: '，人类' }),
    chunk({}, 'stop'),
  ]);

  assert.equal(lastAccumulated.content, '你好，人类');
  assert.equal(doneCount, 1);
});

test('assembleStreamRecursive 合并分片的 tool_calls 参数', async () => {
  const { lastAccumulated } = await assemble([
    chunk({
      tool_calls: [{
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'send_message', arguments: '{"con' },
      }],
    }),
    chunk({
      tool_calls: [{
        index: 0,
        function: { arguments: 'tent":"你好"}' },
      }],
    }),
    chunk({}, 'tool_calls'),
  ]);

  const toolCall = lastAccumulated.tool_calls[0];
  assert.equal(toolCall.id, 'call_1');
  assert.equal(toolCall.function.name, 'send_message');
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { content: '你好' });
});

test('assembleStreamRecursive 支持多个并行 tool_calls 按索引归位', async () => {
  const { lastAccumulated } = await assemble([
    chunk({
      tool_calls: [
        { index: 0, id: 'call_a', type: 'function', function: { name: 'send_message', arguments: '{"content":"a"}' } },
        { index: 1, id: 'call_b', type: 'function', function: { name: 'set_mood', arguments: '{"mood":80' } },
      ],
    }),
    chunk({
      tool_calls: [
        { index: 1, function: { arguments: ',"reason":"测试"}' } },
      ],
    }),
    chunk({}, 'tool_calls'),
  ]);

  assert.equal(lastAccumulated.tool_calls.length, 2);
  assert.equal(lastAccumulated.tool_calls[0].function.name, 'send_message');
  assert.deepEqual(JSON.parse(lastAccumulated.tool_calls[1].function.arguments), { mood: 80, reason: '测试' });
});

test('长流不会爆栈（回归：yield* 递归实现的 Maximum call stack size exceeded）', async () => {
  // 生产事故：每来一个分片递归一层，长回复直接把调用栈打爆，整轮 reAct 失败。
  // 这里给 20 万个分片——循环实现只占一个栈帧，递归实现必然溢出。
  const CHUNKS = 200_000;

  async function* longStream() {
    for (let i = 0; i < CHUNKS; i++) {
      yield chunk({ content: 'x' }, i === CHUNKS - 1 ? 'stop' : null);
    }
  }

  let last: any = null;
  let count = 0;

  const gen = LLMCall.assembleStream(longStream());
  for await (const delta of gen) {
    last = delta.accumulated;
    count += 1;
  }

  assert.equal(count, CHUNKS);
  assert.equal((last as { content: string }).content.length, CHUNKS, '全部增量都应被拼接');
});

test('assembleStreamRecursive 别名仍可用（兼容旧调用）', async () => {
  const gen = LLMCall.assembleStreamRecursive(fakeStream([chunk({ content: 'ok' }, 'stop')])[Symbol.asyncIterator]());
  const chunks: any[] = [];
  for await (const c of gen) chunks.push(c);
  assert.equal(chunks.length, 1);
  assert.equal((chunks[0].accumulated as { content: string }).content, 'ok');
});

test('思考流按段聚合，不是逐 token 一行（日志刷屏回归）', async () => {
  // 生产现象：react.ts 每个流分片都 emitLog，debug WS 打过去就是"一字一行"，
  // 一分钟数百行日志。这里验证聚合阈值：180 个单字分片 → 至多 2 条日志。
  const REACT_SRC = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/brain/react.ts', import.meta.url), 'utf8'),
  );
  assert.match(REACT_SRC, /THOUGHT_FLUSH_CHARS/, '应有聚合阈值常量');
  assert.match(REACT_SRC, /thoughtBuffer \+= content/, '应累积而非逐个 emitLog');
  assert.ok(
    !/if \(content\) this\.emitLog\('thought', content\)/.test(REACT_SRC),
    '不应再逐个分片 emitLog',
  );

  // 聚合逻辑本身：180 字 → 阈值 120 时先 flush 一次，收尾再 flush 一次
  const THRESHOLD = 120;
  const chunks = Array.from({ length: 180 }, () => 'x');
  let buffer = '';
  let flushes = 0;
  for (const c of chunks) {
    buffer += c;
    if (buffer.length >= THRESHOLD || buffer.includes('\n')) { flushes += 1; buffer = ''; }
  }
  if (buffer) flushes += 1;
  assert.equal(flushes, 2);
});
