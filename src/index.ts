import { Character } from './brain/character.js';
import { CharacterConfig } from './api/types.js';

// 完善后的示例配置
const exampleConfig: CharacterConfig = {
  id: 'buddy-001',
  name: 'AliveBuddy',
  bio: 'A helpful autonomous agent.',
  system_prompt_template: 'You are {{name}}, currently feeling {{mood}}...',
  initial_state: { mood: 50, energy: 100, boredom: 0 },
  connection: {
    base_url: 'https://api.openai.com/v1',
    send_url: 'https://api.openai.com/v1/chat/completions',
    connect_head: 'Authorization: Bearer YOUR_KEY',
    send_head: 'Authorization: Bearer YOUR_KEY',
    model: 'gpt-4o'
  },
  extend_tool_list: [],
  extend_skills_list: [],
  llm_setting: {
    temperature: 0.7,
    max_tokens: 500
  }
};

console.log('[DEBUG] Starting alive-buddy entry point...');
const buddy = new Character(exampleConfig);

// 模拟心跳
setInterval(async () => {
  await buddy.pulse();
}, 10000); // 10秒一个脉搏用于测试
