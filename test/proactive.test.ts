import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveEngine, ProactiveState } from '../src/brain/proactive.js';
import { ProactiveModelClient } from '../src/ml/client.js';

function stubClient(probability: number | null): ProactiveModelClient {
  return { predict: async () => probability } as unknown as ProactiveModelClient;
}

const baseState: ProactiveState = {
  mood: 50,
  energy: 80,
  boredom: 30,
  last_interaction_at: Date.now() - 60_000,
};

test('buildFeatures 将状态值约束进 [-100, 100] 并生成合法特征', () => {
  const engine = new ProactiveEngine({ client: stubClient(0) });
  const features = engine.buildFeatures({ ...baseState, mood: 150, energy: -999, boredom: 42.6 });

  assert.equal(features.mood, 100);
  assert.equal(features.energy, -100);
  assert.equal(features.boredom, 43);
  assert.ok(features.time_cos >= -1 && features.time_cos <= 1);
  assert.ok(features.time_since_last_msg >= 0);
  assert.ok(features.noise >= 0 && features.noise < 1);

  // 同一时刻最多只属于一种时段
  const periodCount = [features.is_breaking_time, features.is_working_time, features.is_sleeping_time]
    .filter(Boolean).length;
  assert.ok(periodCount <= 1);
});

test('decide 在概率达到阈值时触发主动行为', async () => {
  const engine = new ProactiveEngine({ client: stubClient(0.9), threshold: 0.5 });
  const decision = await engine.decide(baseState);

  assert.equal(decision.shouldAct, true);
  assert.equal(decision.probability, 0.9);
  assert.equal(decision.threshold, 0.5);
});

test('decide 在概率低于阈值时保持静默', async () => {
  const engine = new ProactiveEngine({ client: stubClient(0.2), threshold: 0.5 });
  const decision = await engine.decide(baseState);

  assert.equal(decision.shouldAct, false);
  assert.equal(decision.probability, 0.2);
});

test('decide 在距离上次主动脉冲过近时抑制触发', async () => {
  const engine = new ProactiveEngine({ client: stubClient(0.9), minIntervalMs: 60_000 });
  const decision = await engine.decide({ ...baseState, last_pulse_at: Date.now() - 1_000 });

  assert.equal(decision.shouldAct, false);
  assert.match(decision.reason, /Too soon/);
});

test('decide 在 sidecar 不可用时优雅降级', async () => {
  const engine = new ProactiveEngine({ client: stubClient(null) });
  const decision = await engine.decide(baseState);

  assert.equal(decision.shouldAct, false);
  assert.match(decision.reason, /unavailable/);
});
