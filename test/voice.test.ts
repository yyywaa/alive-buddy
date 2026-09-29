import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VOICE_ROTATION_REMINDER } from '../src/brain/voice.js';

test('腔调提醒只约束形式，不指定内容', () => {
  assert.match(VOICE_ROTATION_REMINDER, /换一副嗓子/);
  assert.match(VOICE_ROTATION_REMINDER, /连用三次算失败/);
  // 不得出现题材指定（那属于内容，由角色自己决定）
  for (const topic of ['Minecraft', '星象', '炼金', '玩家世界']) {
    assert.ok(!VOICE_ROTATION_REMINDER.includes(topic), `不该指定题材：${topic}`);
  }
});

test('列出的嗓子与人设一致', () => {
  for (const register of ['君王腔', '野兽腔', '老贵族腔', '旧日腔', '刻薄腔']) {
    assert.ok(VOICE_ROTATION_REMINDER.includes(register), `缺少 ${register}`);
  }
});

test('react.ts 每轮都把提醒注入 system 上下文', () => {
  const src = fs.readFileSync('src/brain/react.ts', 'utf8');
  assert.match(src, /VOICE_ROTATION_REMINDER/, '应当导入提醒');
  assert.match(src, /voiceReminder/, '应当注入 system 内容');
  assert.ok(
    /\$\{voiceReminder\}/.test(src),
    '提醒必须进到 system 提示里，否则等于没加',
  );
});
