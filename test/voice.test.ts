import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VOICE_FIT_REMINDER } from '../src/brain/voice.js';

test('提醒只给"想清楚"的问题，不指定腔调', () => {
  assert.match(VOICE_FIT_REMINDER, /一个博学傲慢的末影龙王/);
  assert.match(VOICE_FIT_REMINDER, /会怎么说话？/);
  assert.match(VOICE_FIT_REMINDER, /没有规定/);
  assert.match(VOICE_FIT_REMINDER, /而不是一个助手、或一个学者会说的话/);
  assert.match(VOICE_FIT_REMINDER, /不超过三句/);
});

test('不再有任何腔调清单/场合映射/轮值规则', () => {
  for (const removed of ['学者腔', '君王腔', '野兽腔', '老贵族腔', '轮', '场合']) {
    assert.ok(!VOICE_FIT_REMINDER.includes(removed), `不该再指定：${removed}`);
  }
});

test('不指定内容题材', () => {
  for (const topic of ['Minecraft', '星象', '炼金', '玩家世界']) {
    assert.ok(!VOICE_FIT_REMINDER.includes(topic), `不该指定题材：${topic}`);
  }
});

test('react.ts 每轮都把提醒注入 system 上下文', () => {
  const src = fs.readFileSync('src/brain/react.ts', 'utf8');
  assert.match(src, /VOICE_FIT_REMINDER/, '应当导入提醒');
  assert.ok(/\$\{voiceReminder\}/.test(src), '提醒必须进到 system 提示里');
});
