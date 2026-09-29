import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAKE_FRAMINGS, WakeStimulus, buildProactiveWakePrompt } from '../src/brain/impulse.js';

test('开放邀请不含任何题材指定（不强制它关注某个方面）', () => {
  // 回归：曾经每次唤醒都指定"话题域 × 言语行为"，等于强制它关注某个方面，
  // 还把题材框在一份人工清单里。
  const forbidden = ['Minecraft', '星象', '炼金', '地质', '词源', '音乐', '宴席', '玩家世界'];
  for (const framing of WAKE_FRAMINGS) {
    for (const word of forbidden) {
      assert.ok(!framing.invite.includes(word), `邀请里不该出现题材限定词：${word}（${framing.id}）`);
    }
  }
});

test('唤醒提示明确说明题材不设限', () => {
  const prompt = buildProactiveWakePrompt(WAKE_FRAMINGS[0], ['我在此守候']);
  assert.match(prompt, /没有任何限定/);
  assert.match(prompt, /题材随你/);
  assert.match(prompt, /与眼前的世界无关/);
  assert.match(prompt, /不会挑|不必挑/);
  assert.match(prompt, /我在此守候/);
  assert.match(prompt, /不要再换个说法重复/);
  assert.match(prompt, /保持沉默完全可以/);
  assert.match(prompt, /不是复述资料/, '应引导它讲自己的见闻，而不是当资料库');
  assert.match(prompt, /腔调/, '应提示注意腔调与场合的匹配');
});

test('措辞会轮换（避免输入完全雷同诱导固定输出）', () => {
  const stimulus = new WakeStimulus(Math.random, 3);
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(stimulus.next().id);

  for (let i = 0; i < ids.length; i++) {
    const window = ids.slice(Math.max(0, i - 3), i);
    assert.ok(!window.includes(ids[i]), `第 ${i} 次与最近 3 次雷同: ${ids[i]}`);
  }
  assert.ok(new Set(ids).size >= WAKE_FRAMINGS.length, '应当把所有措辞都用上');
});

test('抽出的邀请始终来自候选池', () => {
  const stimulus = new WakeStimulus(() => 0.42, 3);
  const ids = new Set(WAKE_FRAMINGS.map(f => f.id));
  for (let i = 0; i < 8; i++) {
    assert.ok(ids.has(stimulus.next().id));
  }
});

test('没有历史发言时不出现空的"最近说过"段落', () => {
  const prompt = buildProactiveWakePrompt(WAKE_FRAMINGS[1], []);
  assert.ok(!prompt.includes('你最近已经说过'));
});
