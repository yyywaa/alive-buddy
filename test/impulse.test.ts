import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEECH_ACTS,
  TOPIC_DOMAINS,
  WakeStimulus,
  buildProactiveWakePrompt,
} from '../src/brain/impulse.js';

/** 固定序列的伪随机，便于断言抽取结果 */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

test('题材池刻意涵盖 Minecraft 之外的方向', () => {
  assert.ok(TOPIC_DOMAINS.length >= 12, '题材域应当足够多才谈得上发散');
  const nonMinecraft = TOPIC_DOMAINS.filter(d => !d.includes('玩家世界') && !d.includes('他们提到'));
  assert.ok(nonMinecraft.length >= TOPIC_DOMAINS.length - 2, '绝大多数方向不应是 Minecraft 题材');
  assert.ok(SPEECH_ACTS.length >= 6);
});

test('连续抽取不会在短周期内重复同一题材', () => {
  const stimulus = new WakeStimulus(Math.random, 4);
  const picked: string[] = [];

  for (let i = 0; i < 20; i++) {
    picked.push(stimulus.next().domain);
  }

  // 滑动窗口内不出现重复
  for (let i = 0; i < picked.length; i++) {
    const window = picked.slice(Math.max(0, i - 4), i);
    assert.ok(!window.includes(picked[i]), `第 ${i} 次与最近 4 次重复: ${picked[i]}`);
  }
});

test('抽取结果始终来自候选池', () => {
  const stimulus = new WakeStimulus(seq([0, 0.999, 0.5, 0.25]), 4);
  for (let i = 0; i < 10; i++) {
    const pick = stimulus.next();
    assert.ok(TOPIC_DOMAINS.includes(pick.domain), pick.domain);
    assert.ok(SPEECH_ACTS.includes(pick.act), pick.act);
  }
});

test('唤醒提示包含方向、反重复清单与反套话要求', () => {
  const prompt = buildProactiveWakePrompt(
    { domain: '星象、时间与钟表（潮汐、节气、历法）', act: '问一个你确实想知道答案的问题' },
    ['虚空依旧安静', '我在此守候'],
  );

  assert.match(prompt, /星象、时间与钟表/);
  assert.match(prompt, /问一个你确实想知道答案的问题/);
  assert.match(prompt, /虚空依旧安静/);
  assert.match(prompt, /不要再换个说法重复/);
  assert.match(prompt, /保持沉默/);
});

test('没有历史发言时不出现空的"最近说过"段落', () => {
  const prompt = buildProactiveWakePrompt({ domain: '旧书、地图与测绘', act: '讲一段旧事' }, []);
  assert.ok(!prompt.includes('你最近已经说过'));
});
