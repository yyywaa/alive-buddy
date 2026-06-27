export interface UnifiedMessage {
  msg_id: string;
  user_id: string;
  session_id: string;
  timestamp: number;
  silent?: boolean; // 若为 true，仅将消息记入记忆作为上下文，不触发 LLM 回复
  payload: {
    role: 'user' | 'assistant' | 'system';
    content: Array<{
      type: 'text' | 'image_url' | 'other';
      text?: string;
      image_url?: { url: string };
      other_url?: { url: string };
      summary?: string; // 用于存储多模态内容的文本概括
    }>;
  };
}

export interface LoreEntry {
  keywords: string[];
  content: string;
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>; // JSON Schema properties
      required?: string[];
    };
  };
}

export interface Skill {
  id: string;
  name: string;
  description: string;
}

export interface LLMSetting {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stream?: boolean; // 是否使用流式输出
}

export interface CharacterConfig {
  id: string;
  name: string;
  avatar?: string;
  bio: string;
  system_prompt_template: string;
  
  // 初始化设置
  initial_state: {
    mood?: number;
    energy?: number;
    boredom?: number;
    energy_consumption_rate?: number; // 每一轮 reAct 消耗的精力，默认 2
  };

  // 接口配置
  connection: {
    base_url: string;
    api_key: string;      // LLM 专用 Key
    send_url: string;     // 客户端发送消息的 URL
    connect_headers: Record<string, string>; // 客户端连接 Headers
    send_headers: Record<string, string>;    // 客户端发送 Headers
    model: string;
  };

  // 扩展参数
  lorebook?: LoreEntry[];
  extend_tool_list?: Tool[];
  extend_skills_list?: Skill[];
  llm_setting?: LLMSetting;
  /**
   * 是否开启 reAct 调试日志输出。
   * 开启后，前端可通过 /v1/session/:id/debug WebSocket 实时查看角色思考过程。
   */
  debug?: boolean;
}

export interface ImpulseResponse {
  action: 'send' | 'think' | 'none';
  payload?: unknown;
}
