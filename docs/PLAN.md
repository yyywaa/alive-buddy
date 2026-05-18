
# alive-buddy

*alive-buddy* 是一个基于机器学习模型和reAct循环的自主行动智能体。

## 行为决策树

相比于传统的专家系统行为树，*alive-buddy*采用了机器学习的方法构建智能体的行为逻辑。

### 训练与蒸馏
*   **基础模型**：预训练一个“平均人类”的通用决策树模型，降低用户部署初期的计算压力。
*   **自动化蒸馏**：通过 LLM 构建“剧本生成器”，生成随机状态组合 `(mood, boredom, energy, time_context)`，由 LLM 配合反馈工具进行标注并自动存储。
*   **个性化微调**：提供用户反馈接口（"您是否愿意在这个时间被角色发消息？",Yes/No/Ignore,以此结果微调模型），同时设置模型调整入口和自定义模型入口，允许用户根据私有数据和偏好微调模型。

### 特征工程与演化
通过独立的 **State Engine** 实现特征的自然演化：
*   **自然漂移**：`energy` 随时间缓慢恢复，在reAct消耗，`boredom` 随上一次回复时间时间增加。
*   **状态依赖**：决策树将学习状态间的耦合关系（如低精力对激活概率的抑制）。

特征参数：
`is_breaking_time`, `is_working_time`, `is_sleeping_time`: bool
`time_cos`: float = cos(2*pi*time / 24)
`time_since_last_msg`: float
`mood`, `boredom`, `energy`: int [-100,100]
`noise`: randomnum

## 模型思考机制

*alive-buddy*将采用reAct模式行动。决策树仅负责“唤醒意识”（Proactive），而 reAct 负责“处理逻辑”（Reactive）。

### 内部思考
*   **internal_monologue**：Agent 可以调用此工具记录内心活动而不发送消息。这些记录将被存入日志或短期记忆，模拟“人脑”在用户说话后的反应（可能是暗自嘀咕而非回复）。
*   **决策自主权**：在用户发送消息触发 reAct 后，由 LLM 自行决定是使用 `send` 工具回复，还是仅进行内部思考并结束循环。
*   **静默思考**：在调用工具以外的文本仅通过日志存储。

### reAct 优化
*   沙箱环境与 Skills 系统。
*   `state_upload`：作为副作用（Side Effect）或提示，由系统在循环结束时根据行为自动/半自动更新状态值，同时应给llm选择权利，也要做成工具。
*   日志实时返回，防止内存溢出。

## 上下文管理 (Memory Architecture)

作为一个长期运行的智能体，采用三层记忆架构结合向量数据库，确保记忆的长期连贯性与检索效率。

### 三层记忆结构
1.  **感知层 (Working Memory)**：
    *   包含最近的 N 条对话记录（含 `internal_monologue`）及当前状态值。
    *   采用 FIFO 机制，超出 Token 阈值后进入总结流程。
2.  **事件层 (Episodic Memory)**：
    *   对感知层挤出的对话进行“滚动总结”（Rolling Summary）。
    *   存储为短期的剧情梗概，模拟对过去几小时或几天事件的记忆。
3.  **印象层 (Semantic Memory)**：
    *   提炼绝对事实（如用户偏好、Agent 自我演化设定）。
    *   存储于向量数据库（如 Chroma/Qdrant），通过语义检索或关键词匹配（类似 Silly Tavern 的 Lorebook）动态注入上下文。

### 记忆总结与更新机制
总结函数支持多种触发重载，确保静默异步更新：
*   **时间触发**：当 `time_since_last_msg` 超过设定阈值（如 2 小时），判定为对话段落结束，触发总结。
*   **容量触发**：感知层 Token 达到警戒水位时，自动剥离旧记录并进行总结。
*   **用户/上下文触发**：
    *   用户主动要求（如“你还记得刚才说了什么吗？”）。
    *   上下文关键节点触发：当 LLM 识别到重要信息变更或任务完成时，可由 reAct 循环主动调用工具触发。
*   **睡眠期固化**：在 `is_sleeping_time` 期间，系统执行批处理任务，将 L2 事件提炼为 L3 长期印象。

### 多模态记忆
*   图片在上传时被视觉模型总结为文本描述，以 `*用户展示了一张图片：[描述]*` 的形式插入记忆流，使其自然参与总结与检索。

## 客户端

设计哲学：把控制权交付用户。

网络请求：cloudscraper

在这个端点接受调用设置，回复频率，用户作息，以此调整决策树触发频率与llm调用。

在有一定前端设计的同时保证后端api的灵活：

1. **消息与事件流**：兼容不同消息格式，支持多模态，拼装成大文本块。图片仅保留最后3张，且在上传时就强制为图片进行概括总结并塞进上下文：
   e.g. `user:这是一只小猫 [image]:a cute black cat.`
   对于 reAct 循环中的连续动作（多次调用 `send`），采用**流式异步推送**，使得事件之间解耦，保证响应灵敏。

2. **接口化设计**：允许用户通过 websocket 协议接入不同聊天室，并确保接口有强大的自由度和整洁度：

   必选参数：
   `connect_head`:string  `base_url`:string  `send_url`:string  `send_head`:string
   `character_prompt`:string

   可选参数：
   `extend_tool_list`:list[Tool]   `extend_skills_list`:list[Skill]
   `llm_setting`:`LLM_setting`
   ......

   两个 head 可以再设计一个合并的版本，利用函数重载让两个接口同时运转，更多设置同理。

3. **日志系统**：实时返回 reAct 思考日志供前端调试，同时具备自动清理机制防止内存溢出。

## Skills 系统与沙箱

*alive-buddy* 拥有一个动态可扩展的技能系统：

*   **动态加载**：LLM 可通过 `get_skill` 工具检索并加载特定技能。支持动态加载预定义的脚本或用户主动上传的技巧片段。
*   **安全与异步**：所有执行均在隔离沙箱环境中运行。耗时任务采用异步模式，避免阻塞 reAct 主循环。

## 技术栈 (Technology Stack)

项目采用“双引擎”架构，平衡 TypeScript 的开发效率与 Python 的机器学习生态：

*   **核心服务端 (API/Logic)**: TypeScript + Fastify/NestJS (处理 WebSocket、reAct 循环、业务逻辑)。
*   **决策引擎 (ML Engine)**: Python + Scikit-learn (实现 `RandomForestRegressor` 决策树与自动化蒸馏流水线)。
*   **数据库**:
    *   **关系型数据库**: SQLite (存储状态值、短期记忆、配置信息)。
    *   **向量数据库**: ChromaDB (存储 L3 长期印象，支持语义检索)。
*   **网络库**: cloudscraper (用于绕过部分反爬/安全限制的客户端请求)。
*   **部署**: Docker + docker-compose。

## 项目结构 (Project Structure)

```text
alive-buddy/
├── src/
│   ├── api/             # TS: Fastify 接口、WebSocket 逻辑与 Adapter 层
│   ├── brain/           # TS: reAct 核心、Prompt 模板、工具分发
│   ├── memory/          # TS: 记忆沉淀逻辑、ChromaDB 接入、SQLite 交互
│   ├── ml/              # Python: 决策树模型、训练脚本、蒸馏生成器
│   └── skills/          # 技巧库：预定义的 Python/JS 技能片段
├── docs/                # 文档
├── data/                # 本地持久化数据（SQLite, ChromaDB 索引）
├── docker/              # Dockerfile 与 配置文件
├── package.json         # Node.js 依赖
└── requirements.txt     # Python 依赖
```









