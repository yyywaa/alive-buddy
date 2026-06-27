# API 文档

alive-buddy 主服务基于 Fastify 提供了 HTTP 与 WebSocket 接口，用于与业务系统进行交互。

## 1. 基础服务

### 初始化 Session
用于实例化一个新的智能体，分配会话 ID，并设置相关的连接参数。

- **URL**: `/v1/session/init`
- **Method**: `POST`
- **Body**: `CharacterConfig` 对象
- **Response**:
  ```json
  {
    "session_id": "uuid-string"
  }
  ```

#### `CharacterConfig` 核心字段说明
```json
{
  "id": "buddy-001",
  "name": "AliveBuddy",
  "bio": "角色设定",
  "system_prompt_template": "You are {{name}}...",
  "initial_state": {
    "mood": 50,
    "energy": 100,
    "boredom": 0,
    "energy_consumption_rate": 2
  },
  "connection": {
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "send_url": "https://your-backend.com/webhook",
    "connect_headers": {},
    "send_headers": {
      "Authorization": "Bearer YOUR_TOKEN"
    },
    "model": "gpt-4o"
  },
  "debug": true
}
```

### 获取当前状态
查询角色的实时演化状态（如精力、无聊度等）。

- **URL**: `/v1/session/:id/status`
- **Method**: `GET`
- **Response**: `RuntimeState`
  ```json
  {
    "mood": 50,
    "energy": 96,
    "boredom": 0,
    "energy_consumption_rate": 2,
    "last_interaction_at": 1716104995000,
    "is_active": false,
    "memory_context": "..."
  }
  ```

## 2. 交互接口

### 实时聊天流
业务端向智能体投递消息的 WebSocket 统一入口。

- **URL**: `ws://<host>:<port>/v1/chat`
- **发送格式**: 必须遵循 `UnifiedMessage` 规范
  ```json
  {
    "msg_id": "client-uuid-123",
    "user_id": "user-888",
    "session_id": "uuid-string",
    "timestamp": 1716104995000,
    "payload": {
      "role": "user",
      "content": [
        { "type": "text", "text": "你好" }
      ]
    }
  }
  ```

> **非常重要**：角色收到该消息后，会启动异步的 reAct 循环进行内部思考。最终的对话结果**不会**通过这个 WebSocket 直接原路返回。它会调用 `send_message` 工具向外发送。

### 角色回复 Webhook (业务端提供)
当智能体内部的 `pulse()`（主动唤醒）或处理 `onMessage`（被动回复）决定对外发言时，会主动调用业务端提供的接口。

- **URL**: 在 `CharacterConfig.connection.send_url` 中配置
- **Method**: `POST`
- **Headers**: 会携带 `CharacterConfig.connection.send_headers` 中的内容
- **Body**:
  ```json
  {
    "content": "发送的具体文字内容"
  }
  ```

## 3. 调试接口

### ReAct 思考过程日志
开启 debug 模式后，可实时连接此 WebSocket 观测智能体的大模型思维链 (thought / action / observation)。

- **URL**: `ws://<host>:<port>/v1/session/:id/debug`
- **前提**: 初始化时，对应 Session 的 `CharacterConfig` 中需设置 `"debug": true`
- **接收格式**:
  ```json
  {
    "type": "debug_log",
    "entry": {
      "type": "thought", // 可能的值: thought | action | observation | error | status
      "content": "我现在有点困，先只在心里想想好了...",
      "timestamp": 1716104995000
    }
  }
  ```
