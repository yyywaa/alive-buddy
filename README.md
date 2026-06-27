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

主服务对外通过 HTTP/WebSocket 暴露接口。典型的接入流程：

1. `POST /v1/session/init`，传入 `CharacterConfig`，获得 `session_id`
2. 建立 WebSocket 连接到 `/v1/chat`，发送 `UnifiedMessage`
3. 智能体的回复通过 `CharacterConfig.connection.send_url` 推出（即它会主动 POST 到你指定的地址）
4. 如需调试，连接 `/v1/session/:id/debug`，实时查看 reAct 思考过程

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
