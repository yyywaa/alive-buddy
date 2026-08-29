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
