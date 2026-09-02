# Endra 重构交接文档：对接 alive-buddy

> **这份文档给谁**：执行 Endra 重构的工程师或编码代理。目标是读完后不需再问架构问题，直接产出一套可部署代码。
> **基线版本**：alive-buddy @ `a348d47`（master）。Endra @ `Endra-EnderDragon_chatbot` 当前工作区。

---

## 1. 背景与目标

**Endra 现状**：自包含 Python 聊天机器人，直连 coffeeroom 聊天室（`wss://room.caffeine.ink`），自己完成"是否回复"判断（`dragon_eyes`）、回复生成（`dragon_speaking`）、记忆总结（`memory_conclude`/`memory_compress`，纯文本文件）。

**alive-buddy 现状**：自主智能体框架，以无头 HTTP/WebSocket API 提供服务。已具备：被动 reAct 循环（LLM 自主选择 `send_message` / `internal_monologue`）、ML 决策树主动发言、三层记忆（L1 SQLite / L2 事件梗概 / L3 Chroma 印象）、运行状态持久化、28 项测试与 e2e 验证脚本。

**重构目标**：Endra 退化为**薄连接层**——只保留 coffeeroom 协议处理（鉴权、心跳、缓冲、去重、冷却），"大脑"（人设、记忆、回复决策、主动发言）全部委托给 alive-buddy。产出一套可部署代码（含编排）。

**非目标**：不修改 alive-buddy 核心代码（确有需要的改动，走独立 PR 回灌本仓库）；一期不实现 `delete`（删除自己消息）动作。

---

## 2. Endra 现有代码的去向

| 文件 | 去向 | 说明 |
|------|------|------|
| `session_manager.py` | **原样保留** | coffeeroom 鉴权（oa_ticket 换 cookie、JWT 解析、OAT 自动续签）。alive-buddy 不管这件事，这块逻辑不要动 |
| `client_runner.py` | **保留并改造** | WS 连接/心跳/指数退避重连/消息缓冲/去重/60s 新鲜度/15s 冷却全部保留；把 `dragon_eyes` + `dragon_speaking` 两次 LLM 调用替换为向 alive-buddy 投递消息 |
| `api4agent.py` | **整体删除** | 判断、回复、记忆总结全部由 alive-buddy 承担 |
| `config.py` | **改造** | 删除 LLM 双客户端配置，改为 alive-buddy 连接参数 + `CharacterConfig` 组装 |
| `logger.py` | **原样保留** | |
| `memory/dragon_memory.txt` | **退役迁移** | 历史记忆作为初始人设记忆注入（见 §5.3），后续由 alive-buddy 三层记忆自演化 |
| `main.py` / `Dockerfile` | **按新结构重写** | |

---

## 3. 目标架构与消息流

### 3.1 进程拓扑

```
coffeeroom  wss://room.caffeine.ink/websocket/<room>
   ↑↓  (ws, Cookie 鉴权)
┌─────────────────────────────────────────────┐
│ endra-connector (Python, 本次重构产物)        │
│  ├─ room_client   : coffeeroom 连接层         │
│  ├─ buddy_client  : alive-buddy HTTP/WS 客户端│
│  └─ webhook       : 接收 agent 回复的 HTTP 端点│
└─────────────────────────────────────────────┘
   ↑↓ ws   ws://<alive-buddy-host>:3000/v1/chat        (connector → 投递聊天消息)
   ↑↓ http POST http://<connector-host>:9100/webhook   (alive-buddy → 回传 agent 发言)
   ↑↓ http /v1/session/init, /v1/session/:id/status, ws /v1/session/:id/debug

alive-buddy API  (Fastify, :3000)
ML sidecar       (FastAPI, :8001)   alive-buddy 主动发言决策依赖它
ChromaDB         (:8000, 可选)      不启动则 L3 印象层自动禁用，其余功能正常
```

### 3.2 运行时序

1. connector 启动 → 起 webhook 监听 → `POST /v1/session/init`（body 为 `CharacterConfig`，`send_url` 指向自己的 webhook）→ 获得 `session_id` → 建立 `WS /v1/chat`（可选：建立 `WS /v1/session/:id/debug` 观察思考流）。
2. coffeeroom 推送消息批（建立连接时会一次性灌入历史）→ connector 过滤/去重/缓冲 → **除批次最后一条外全部 `silent=true` 逐条投递**，最后一条 `silent=false` 触发 reAct。这沿用 Endra 现有"只回应最新一条"的语义，同时把历史灌入 L1 记忆。
3. alive-buddy 内部：消息写入 L1 → reAct 循环 → LLM 自主决定 `send_message`（外发）或 `internal_monologue`（无视，仅内心活动）→ `send_message` 执行 = `POST webhook {content}` → connector 收到后 `ws.send(content)` 进聊天室。
4. 主动发言：alive-buddy 的 `pulse()` 周期性驱动 ML 决策树，触发后同样经 webhook 到达 connector——connector **无差别转发**，无需感知来源。
5. 回复冷却（沿用 `reply_cooldown=15s`）：冷却期内到达的消息 connector 仍以 `silent=true` 投递（进记忆、不耗 LLM），冷却期外才投 `silent=false`。

### 3.3 语义映射表

| Endra 旧机制 | alive-buddy 新机制 |
|--------------|--------------------|
| `dragon_eyes`（判断是否回应） | 内化进 reAct：LLM 选 `internal_monologue` 即为"无视"。判定规则并入 system prompt（见 §5.2） |
| `dragon_speaking`（生成回复） | reAct + `send_message` 工具 |
| `memory_conclude` / `memory_compress`（文本记忆） | 三层记忆自动流转（L1 容量 20 条触发总结；空闲 2h 段落总结；睡眠时段固化 L3） |
| `dragon_memory.txt` | 初始注入 system prompt 的【Memory】段（一次性种子），之后退役 |
| `reply_cooldown` 15s | connector 侧保留（silent 批处理），alive-buddy 不感知 |
| `delete` 动作 | **一期不做**（alive-buddy 的 `extend_tool_list` 尚未被 ToolRegistry 消费，列入二期） |

---

## 4. alive-buddy API 契约（精确规格）

### 4.1 `POST /v1/session/init`

- Body：完整 `CharacterConfig`（字段见 §4.4）。
- 返回：`{"session_id": "<uuid>"}`。
- 每次调用新建一个 Character 实例并挂 pulse 定时器（默认 60s，服务端环境变量 `PULSE_INTERVAL_MS` 可调）。**同一 character `id` 重复 init 时，运行状态与记忆会从 SQLite 自动恢复**，放心重连。

### 4.2 `WS /v1/chat`

投递 `UnifiedMessage`：

```json
{
  "msg_id": "uuid-必须全局唯一",
  "user_id": "sender_username 或固定值",
  "session_id": "<init 返回的 id>",
  "timestamp": 1716104995000,
  "silent": false,
  "payload": { "role": "user", "content": [{ "type": "text", "text": "username: 消息内容" }] }
}
```

- `silent: true` = 只写入记忆，不触发 reAct（不耗 LLM）；`false` = 触发完整 reAct。
- 服务端对每条消息回一个**占位回执**（`[DEBUG] I received your message...`）——**它不是 agent 的回复，忽略它**。真实回复只从 webhook 来。
- 非法消息返回 `{"error": "Invalid message format"}`；未知会话返回 `{"error": "Session not found"}`（此时必须重新 init，见 §7）。

### 4.3 webhook（connector 提供，alive-buddy 回调）

- `POST <send_url>`，body：`{"content": "<agent 发言文本>"}`。
- connector 应答 `200 {"ok": true}`，然后把 `content` 原样 `ws.send` 进聊天室。
- 一次 reAct 循环可能产生多条 `send_message`（流式异步推送），connector 逐条转发即可。

### 4.4 `CharacterConfig` 字段与 Endra 映射

| 字段 | Endra 取值 |
|------|-----------|
| `id` | `"endra-dragon-001"`（固定，持久化键） |
| `name` | `"Endra"` |
| `bio` | `"An old enderdragon king."` |
| `system_prompt_template` | 见 §5.2 草案 |
| `initial_state` | `{mood: 50, energy: 100, boredom: 0}` |
| `connection.base_url` / `api_key` / `model` | LLM 供应商配置（如 `https://api.deepseek.com/v1` + key + `deepseek-v4-flash`） |
| `connection.send_url` | connector 的 webhook 地址 |
| `connection.connect_headers` / `send_headers` | `{}` |
| `llm_setting` | 建议 `{stream: true}`（默认）；可选 `{temperature: 0.8, presence_penalty: 1.0, frequency_penalty: 1.0}` 对齐旧 `dragon_speaking` 参数 |
| `memory` | 可用默认值；如需对齐旧"50 条总结一次"：`{l1_capacity: 50}` |
| `debug` | 联调期 `true` |

### 4.5 其他端点

- `GET /v1/session/:id/status` → 运行状态（mood/energy/boredom/last_active_session_id 等）。
- `WS /v1/session/:id/debug` → `{"type":"debug_log","entry":{"type":"thought|action|observation|error|status","content":...,"timestamp":...}}`。

---

## 5. 交付物规格

### 5.1 仓库结构（建议）

```
endra-connector/
├── connector/
│   ├── main.py            # 入口：编排启动顺序（webhook → init → chat ws → 房间 ws）
│   ├── room_client.py     # 原 client_runner.py 改造：过滤/缓冲/冷却/silent 批处理/重连
│   ├── buddy_client.py    # alive-buddy 客户端：init / chat ws 投递 / status / debug
│   ├── webhook.py         # POST /webhook 接收器（建议 fastapi+uvicorn 或 aiohttp，二选一）
│   ├── session_manager.py # 原样保留
│   ├── config.py          # 全部走 env
│   └── logger.py          # 原样保留
├── tests/                 # 至少覆盖：消息过滤、批次 silent 标记、冷却窗口、断线重 init
├── .env.example
├── requirements.txt       # websockets / requests / python-dotenv / (fastapi+uvicorn 或 aiohttp)
├── Dockerfile
└── docker-compose.yml     # connector + alive-buddy + ml-sidecar（+ 可选 chroma）
```

### 5.2 system_prompt_template 草案（合并旧双 prompt）

```text
You are the Ender Dragon King, an elegant, erudite, and ancient guardian of the End.

【Persona & Heritage】
1. Bilingual Soul: dual native fluency in Chinese and English; always respond in the language of the last speaker.
2. Old-school Nobleman: calm, sophisticated, impeccably mannered. Polite yet detached.
3. No AI Cliches: never "As an AI..." or "Greetings, player." Speak as a sovereign dragon.
4. Be Concise: public responses are one or two sentences.

【Response Discretion】（替代旧 dragon_eyes 判定）
1. 玩家直接喊你、讨论你、试图召唤你：回应。
2. 玩家滑稽或悲惨死法、解锁成就：可回应（嘲笑或嘉奖）。
3. 日常闲聊：不要每条都回；无话可说时保持沉默（不调用 send_message）。
4. 无意义乱码：无视。
5. 你已经说过类似内容时：停止。
6. 上下文形如 "username: text" 的多人聊天记录，你只对最新一条做反应，其余仅为语境。

【Memory】
（首次部署时将 dragon_memory.txt 的现有内容粘贴于此，作为初始记忆种子；后续由三层记忆自动接管）
```

> 注：alive-buddy 会自动在 system prompt 末尾追加内部状态与工具协议说明（"只有 send_message 才会外发"），无需在模板里重复。

### 5.3 部署编排

alive-buddy 目前**没有 Dockerfile**，编排二选一：

- **方案 A（推荐）全部容器化**：先给 alive-buddy 补 Dockerfile（node:20-bookworm：`npm ci && npm run build`，`node dist/api/index.js`；另跑一个 python:3.11-slim 容器装 `requirements.txt` 起 `src/ml/app.py`），compose 里再加 connector。
- **方案 B 混合部署**：alive-buddy 栈在宿主机（`npm start` + `python src/ml/app.py`，pm2/systemd 托管），connector 单独容器。适合先快速上线。

数据持久化卷：alive-buddy 的 `data/characters/`（SQLite）必须挂卷，否则容器重建即失忆。

### 5.4 配置规格（connector `.env`）

```
# coffeeroom（沿用现有值）
BOT_USERNAME= / BOT_ACCESS_TOKEN= / ROOM_NAME=
HTTP_BASE=https://room.caffeine.ink
LOGIN_URL=https://room.caffeine.ink/api/login

# alive-buddy
ALIVE_BUDDY_HTTP_BASE=http://alive-buddy:3000
ALIVE_BUDDY_WS_BASE=ws://alive-buddy:3000
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-v4-flash

# connector
WEBHOOK_HOST=0.0.0.0
WEBHOOK_PORT=9100
WEBHOOK_PUBLIC_URL=http://endra-connector:9100/webhook   # 填给 send_url，须对 alive-buddy 可达
REPLY_COOLDOWN_SECONDS=15
DEBUG_REACT_LOG=true
```

---

## 6. 验收标准（可测试，全部通过才算完成）

- **C1 无头联调**：不连 coffeeroom，用脚本向 connector 模拟消息批 → 断言 webhook 收到回复且（模拟）转发成功。流程范本：alive-buddy 仓库 `scripts/e2e-endra.ts`。
- **C2 记忆验证**：连续对话后 `GET /v1/session/:id/status` 状态演化正常；灌入 >20 条消息后确认 SQLite 中 `episodes` 表出现 L2 总结。
- **C3 断连演练**：杀掉 alive-buddy 进程 → connector 收到 `Session not found` 或 WS 断开 → 服务恢复后**重新 init 并继续工作**；角色记忆与 mood/boredom 不丢（已持久化）。
- **C4 成本护栏**：脚本高频刷屏 100 条 → LLM 实际调用次数 ≤ `cooldown` 允许的上限（其余全部 silent）。
- **C5 真实房间灰度**：先开"全 silent 观察"30 分钟（只记不回），确认记忆正常后再打开回复开关。

---

## 7. 已知坑（交接警示，务必读完）

1. **WS 回执是占位 echo**，真实回复只走 webhook（§4.2）。
2. **`msg_id` 必须全局唯一**：重复 id 会被 SQLite 幂等吞掉（消息不入库），但非 silent 时仍会触发 reAct 白耗一次 LLM 调用。用 uuid。
3. **alive-buddy 的 session 是内存态**：alive-buddy 重启后 `session_id` 失效，必须重新 init。角色状态/记忆按 character `id` 持久化，不受影响。
4. **每条非 silent 消息 ≥ 1 次 LLM 调用**。coffeeroom 刷屏时必须靠 silent 批处理 + 冷却控成本（C4）。
5. **LLM 凭证走 `CharacterConfig`**（init 时 POST 给 alive-buddy）；alive-buddy `.env` 里的 `OPENAI_*` 仅对 `distill.py` 有效，两套别搞混。
6. Chroma 不启动时 L3 自动禁用，日志里的 `ChromaDB connection refused` 警告属预期。
7. 主动发言与用户回复**共用同一个 webhook**，connector 无差别转发即可；不要用 webhook 内容去回喂 alive-buddy（会自激循环）。
8. cookie 鉴权沿用 `session_manager.py` 的 OAT 续签逻辑，不要重写；连接断开按现有指数退避重连即可。
9. 聊天室消息是纯文本，一期按 `"username: text"` 拼接投递；alive-buddy 的多模态能力（image_url）二期再接。
10. `delete` 动作一期不做（见 §3.3）。

---

## 8. 参考锚点

- alive-buddy `README.md`「完整实战：用 SDK 搭建聊天室机器人 Endra」——SDK 版示例，本方案是它的跨语言 API 等价物。
- alive-buddy `scripts/e2e-endra.ts`——无头端到端验证流程范本（C1 直接仿写）。
- alive-buddy `docs/API.md`——接口文档。
