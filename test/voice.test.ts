import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VOICE_FIT_REMINDER } from '../src/brain/voice.js';

test('腔调提醒是"看场合选"，不是机械轮换', () => {
  assert.match(VOICE_FIT_REMINDER, /先判断眼前是什么场合/);
  assert.match(VOICE_FIT_REMINDER, /不是轮流换/);
  assert.ok(!/连用三次算失败/.test(VOICE_FIT_REMINDER), '不应再是轮值规则');
});

test('人文话题指向学者腔与查证，龙话题指向"你就是末影龙"', () => {
  assert.match(VOICE_FIT_REMINDER, /学者腔/);
  assert.match(VOICE_FIT_REMINDER, /用工具查/);
  assert.match(VOICE_FIT_REMINDER, /你就是末影龙/);
  assert.match(VOICE_FIT_REMINDER, /别用人类学者的口吻讲自己/);
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
