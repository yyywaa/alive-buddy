import 'dotenv/config';
import { Character } from './brain/character.js';
import { CharacterConfig } from './api/types.js';
import { initChroma } from './memory/chroma.js';

// 完善后的示例配置
const exampleConfig: CharacterConfig = {
  id: 'buddy-001',
  name: 'AliveBuddy',
  bio: 'A helpful autonomous agent.',
  system_prompt_template: 'You are {{name}}, currently feeling {{mood}}...',
  initial_state: { mood: 50, energy: 100, boredom: 0 },
  connection: {
    base_url: 'https://api.openai.com/v1',
    api_key: 'sk-your-key',
    send_url: 'https://your-chatroom-api.com/send',
    connect_headers: {
      'Authorization': 'Bearer YOUR_KEY',
      'Content-Type': 'application/json'
    },
    send_headers: {
      'Authorization': 'Bearer YOUR_KEY'
    },
    model: 'gpt-4o'
  },
  extend_tool_list: [],
  extend_skills_list: [],
  llm_setting: {
    temperature: 0.7,
    max_tokens: 500
  }
};

// 初始化 ChromaDB；若未运行，仅打印警告，不阻塞核心链路
initChroma().catch(err => {
  console.warn('[DEBUG] ChromaDB initialization failed, L3 memory will be disabled:', err);
});

console.log('[DEBUG] Starting alive-buddy entry point...');
const buddy = new Character(exampleConfig);

// 模拟心跳
setInterval(async () => {
  await buddy.pulse();
}, 10000); // 10秒一个脉搏用于测试
