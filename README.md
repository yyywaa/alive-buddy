# alive-buddy

自主行动智能体框架，基于 ML 决策树（RandomForest）和 reAct 循环实现。区别于传统聊天机器人的地方在于，它有"主动说话"的驱动机制：靠一个决策树模型（而非写死的规则）来判断当前时间、状态下是否应该主动发消息。

---

## 工作原理

两条并行的驱动链路：

**主动链路（Proactive）**：定时 `pulse()` → 特征提取 → ML sidecar 推理 → 超过阈值 → 进入 reAct 循环 → 自行决定说什么

**被动链路（Reactive）**：收到用户消息 → `onMessage()` → 进入 reAct 循环 → 决定是回复还是独白

reAct 循环内部：LLM 生成 thought → 选择调用工具（`send_message` 或 `internal_monologue`）→ 获取 observation → 继续或终止，最多 10 步。

---

## 依赖服务

项目运行需要三个进程同时在线：

| 服务 | 默认端口 | 说明 |
|------|---------|------|
| TS 主服务 | `3000` | Fastify，处理 API 和 WebSocket |
| ML Sidecar | `8001` | Python FastAPI，提供 `/predict` 推理接口 |
| ChromaDB | `8000` | 向量数据库，存储 L3 长期印象，可选 |

---

## 快速开始

本项目采用**双引擎架构**，运行完整功能需要同时开启多个终端并分别启动对应的服务。

### 0. 一键安装环境 (推荐)

项目内置了自动检查依赖、安装库与生成 `.env` 的脚本：

```bash
./install.sh
```

*(如果你想手动安装，需执行 `npm install` 与 `pip install -r requirements.txt`，并手动配置 `.env`，参考下面说明)*

> `.env` 核心配置说明：
> ```env
> OPENAI_API_KEY="your-api-key"
> OPENAI_BASE_URL="https://api.openai.com/v1"   # 兼容 OpenAI 格式即可
> LLM_MODEL="gpt-4o"
> 
> ML_SIDECAR_URL="http://127.0.0.1:8001"
> CHROMA_URL="http://127.0.0.1:8000"
> ```

### 1. 终端 A：启动 ML Sidecar (必须)

智能体的“主动思考”能力依赖此 Python 决策树服务。

```bash
cd src/ml
python app.py
```

### 2. 终端 B：启动主服务 (必须)

负责 WebSocket 通信、大模型调用与 SQLite 短期记忆管理。

```bash
# 开发模式启动
npm run dev

# 如果已全局安装 (npm install -g)，可直接使用快捷命令启动
alive-buddy
```

### 3. 终端 C：启动 ChromaDB (可选)

存储长期印象（L3 记忆）。如果不启动，主服务代码会降级处理并仅依赖 SQLite。

```bash
chroma run --path ./data/chroma --port 8000
```

---

## 使用方式

### 1. Node.js SDK 模式 (推荐)
如果你在 Node.js 环境下开发（例如开发微信/Discord 机器人），推荐直接使用 `AliveBuddyClient` SDK。它能在内部自动架设 Webhook 拦截消息，并自动拉起所有必需的底层进程，让你彻底告别繁琐的网络通信。

#### 核心用法与参数说明

```typescript
import { AliveBuddyClient } from 'alive-buddy';

const client = new AliveBuddyClient({
  // 1. 核心角色配置
  config: myCharacterConfig, 
  
  // 2. 服务自动拉起策略
  services: {
    api: true,     // 自动后台拉起 Node 主服务 (Fastify)
    ml: true,      // 自动后台拉起 Python 决策树服务
    chroma: false  // 是否拉起 ChromaDB (没有安装可填 false)
  },
  
  // 3. 消息流接管模式 (YOLO Mode 开关)
  // true (默认): 开启内置 Webhook。SDK 自动劫持 agent 的回复，你可以通过 client.on('message') 拿到原始文本。
  // false: 开启 YOLO 模式。SDK 不做拦截，完全信任并调用你在 config 中填写的 send_url 进行消息外发。
  interceptMessage: true 
});

// ---- 【普通模式】 (interceptMessage: true) ----
// 此时 SDK 已全面接管消息流，你的程序需要自行决定将这段话发给谁、如何过滤
client.on('message', (content) => {
  console.log('🤖 收到 Agent 回复:', content);
  // 例如：调用真实的 IM 平台接口发送
  // myDiscordBot.sendMessage(channelId, content);
});

// 监听机器人的内部思考过程 (前提是 config.debug = true)
client.on('debug', (log) => {
  console.log('🧠 思考流:', log.content);
});

// 一键启动，拉起所有进程并完成 WebSocket 握手
await client.start();

// 直接发送文本消息
client.sendMessage('你好！');
```

#### 关于 YOLO 模式 (`interceptMessage: false`)
如果你仅仅想用 `AliveBuddyClient` 作为一个简单的“进程编排器”来帮你拉起 ML 和 API 服务，而消息分发逻辑你已经搭建好了独立的外部服务端（例如用 Go 写的统一网关），你可以将 `interceptMessage` 设为 `false`。
此时请注意：
- SDK **不会**在内部拦截消息，`client.on('message')` 不会触发。
- 你**必须**在传入的 `config.connection.send_url` 和 `send_headers` 中填写正确的外网或局域网真实回调地址。
- 智能体会把底层直接暴露给你，完全不经过客户端的聊天室端信息过滤，直接向该地址发起真实的 HTTP POST 请求。

### 2. 跨语言 API 模式 (独立部署)
如果你使用 Python、Go 等其他语言，或是将 `alive-buddy` 部署在独立服务器上，可以通过标准的 HTTP/WebSocket 接口交互：

1. **初始化会话**: `POST /v1/session/init`，传入 `CharacterConfig` 获得 `session_id`。
2. **连接聊天流**: `ws://<host>:<port>/v1/chat`，投递消息。
3. **接收主动回复**: 智能体会将决策后的结果，通过 POST 请求主动发送到你配置的 `send_url` Webhook。

详见 [docs/API.md](docs/API.md)。

---

## 项目结构

```
alive-buddy/
├── src/
│   ├── api/             # Fastify 路由、WebSocket、类型定义
│   ├── brain/
│   │   ├── character.ts # Character 类，生命周期管理
│   │   ├── react.ts     # reAct 循环引擎
│   │   ├── proactive.ts # 主动决策模块，特征构建与阈值判断
│   │   ├── llm.ts       # LLM 调用封装
│   │   └── tools/       # 内置工具：send_message, internal_monologue
│   ├── memory/
│   │   ├── MemoryManager.ts  # L1/L2/L3 记忆管理
│   │   ├── sqlite.ts         # L1 感知层、L2 事件层（SQLite）
│   │   └── chroma.ts         # L3 印象层（ChromaDB）
│   └── ml/
│       ├── app.py       # FastAPI sidecar 入口
│       ├── model.py     # RandomForestClassifier 封装
│       ├── distill.py   # LLM 驱动的数据蒸馏脚本
│       └── client.ts    # TS 侧调用 sidecar 的客户端
├── data/
│   ├── training_data.csv    # 预置训练数据
│   └── characters/          # 角色持久化数据（SQLite）
└── docs/
    ├── PLAN.md              # 设计文档
    └── API.md               # 接口文档
```

---

## 记忆架构

三层结构，从热到冷：

- **L1 感知层**：最近 N 条对话，SQLite 存储，直接注入上下文。超出容量后触发 L2 总结
- **L2 事件层**：LLM 对过期对话生成的"剧情梗概"，SQLite 存储
- **L3 印象层**：从 L2 提炼的绝对事实（"用户喜欢猫"），ChromaDB 存储，按语义检索后注入上下文

多模态降级：上下文中最多保留最后 3 张图片，更早的图片会被替换为其文字描述。

---

## 当前状态

早期原型，核心链路可用，部分功能仍在开发中（State Engine 的自然演化、Skills 沙箱、用户反馈微调）。详见 [docs/PLAN.md](docs/PLAN.md)。

---

**License**: MIT  
**Author**: yyywaa (951899550@qq.com)
