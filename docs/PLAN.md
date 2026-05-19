
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

### 接口定义
*   **双向通信**：基于 WebSocket 协议，允许用户接入不同聊天室。
*   **统一消息格式 (UnifiedMessage)**：
    ```json
    {
      "msg_id": "client-uuid-789012",
      "user_id": "user-888",
      "session_id": "room-101",
      "timestamp": 1716104995000,
      "payload": {
        "role": "user",
        "content": [
          { "type": "text", "text": "你看这张图里有什么？" },
          { "type": "image_url", "image_url": { "url": "https://..." } }
        ]
      }
    }
    ```
    *payload 遵循 OpenAI 多模态规范。*

*   **配置参数**：
    *   必选：`connect_head`, `base_url`, `send_url`, `character_prompt` 等。
    *   可选：`extend_tool_list`, `llm_setting` 等。

3. **日志系统**：实时返回 reAct 思考日志供前端调试，同时具备自动清理机制防止内存溢出。

## Skills 系统与沙箱

*alive-buddy* 拥有一个动态可扩展的技能系统：

*   **动态加载**：LLM 可通过 `get_skill` 工具检索并加载特定技能。支持动态加载预定义的脚本或用户主动上传的技巧片段。
*   **安全与异步**：所有执行均在隔离沙箱环境中运行。耗时任务采用异步模式，避免阻塞 reAct 主循环。

## API 接口与 Character 类

本项目作为一个库暴露给用户，其核心是 `Character` 类。该类负责管理智能体的生命周期、状态演化与记忆检索。

### Character 类结构

```typescript
class Character {
  // 静态配置：包含身份设定、初始化参数与连接信息
  config: CharacterConfig;
  
  // 运行状态：随时间演化的动态数据，支持序列化持久化
  runtime_state: {
    mood: number;
    energy: number;
    boredom: number;
    last_interaction_at: number;
    is_active: boolean;
    memory_context: string;
  };

  /**
   * @param config 基础配置与初始状态
   * @param saved_state (可选) 上次持久化的运行状态。若提供，则覆盖初始化状态。
   */
  constructor(config: CharacterConfig, saved_state?: Partial<Character['runtime_state']>);

  /**
   * 核心脉搏：处理状态自然演化，并调用决策树判定是否主动触发消息
   * 建议由用户通过定时器（如每分钟一次）调用
   */
  async pulse(): Promise<ImpulseResponse | null>;

  /**
   * 被动响应：当接收到用户消息时触发
   * @param message 遵循 UnifiedMessage 格式
   */
  async onMessage(message: UnifiedMessage): Promise<void>;

  /**
   * 状态导出：将当前的 runtime_state 导出，方便用户存入 SQLite 或其他持久化介质
   */
  dumpState(): Partial<Character['runtime_state']>;
}
```

### 核心设计原则
1.  **初始化与状态分离**：`initial_state` 定义了智能体的“出厂设定”，而 `runtime_state` 记录了它在运行过程中的“性格演化”。
2.  **RAG 化 Lorebook**：不再采用简单的关键词硬匹配，而是将 Lorebook 内容向量化，通过 RAG (Retrieval-Augmented Generation) 机制，根据当前对话语义动态检索并注入上下文。
3.  **主动权与实时性**：通过 `pulse()` 方法，智能体获得了“主观时间感”，能够根据无聊度或精力值自发产生回复冲动。

### 统一消息格式 (UnifiedMessage)
```json
{
  "msg_id": "uuid",
  "user_id": "user-id",
  "session_id": "session-id",
  "timestamp": 1716104995000,
  "payload": {
    "role": "user",
    "content": [
      { "type": "text", "text": "内容" },
      { "type": "image_url", "image_url": { "url": "..." } }
    ]
  }
}
```

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
## 待办事项与路线图 (Roadmap)

### 1. 决策引擎 (The "Proactive" Heart) - **优先级：高**
*   [ ] 实现 `src/ml` 下的 Python 侧边栏推理服务。
*   [ ] 编写 `RandomForestRegressor` 训练与自动化蒸馏脚本。
*   [ ] 实现 **State Engine**：能量自然恢复与无聊度随时间演化的物理公式。

### 2. 记忆中枢 (The "Long-term" Memory) - **优先级：高**
*   [ ] 对接 SQLite：实现 `runtime_state` 与 L1 对话历史的持久化。
*   [ ] 对接 ChromaDB：实现基于 RAG 的 L3 长期印象检索。
*   [ ] 实现异步总结机制：定期将 L1 旧消息压缩为 L2 事件梗概。

### 3. 技能沙箱 (The "Extendable" Skills) - **优先级：中**
*   [ ] 开发 `src/skills` 的动态加载器，支持热更新技巧。
*   [ ] 构建安全沙箱环境，用于执行外部 Python/JS 脚本。

### 4. 客户端适配器与穿透 - **优先级：中**
*   [ ] 在 `SendMessageTool` 中集成 `cloudscraper`，增强网络穿透力。
*   [ ] 完善 WebSocket 日志流，确保 `ReActLogEntry` 实时推送到 UI。

### 5. 进化循环 - **优先级：低**
*   [ ] 实现 "Yes/No/Ignore" 用户反馈系统，支持模型个性化微调。









