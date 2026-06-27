# Release v0.0.0

这是 `alive-buddy` 的首个早期原型（Prototype）版本。

## 🚀 核心特性 (Features)

1. **双驱动引擎 (Dual-Engine Architecture)**
   - **Proactive (主动链路)**: 内置基于 `RandomForestClassifier` 的机器学习决策树，根据智能体当前的精力、无聊度、时间等特征，自发决定是否主动发起对话。
   - **Reactive (被动链路)**: 基于 reAct (Reasoning and Acting) 模式的循环思考引擎，收到用户消息后可自主决定回复内容或仅进行内部独白。

2. **三层记忆架构 (Three-tier Memory)**
   - **L1 感知层**: 使用 SQLite 存储近期对话，保证高速读写。
   - **L2 事件层**: 自动将过期对话总结为“剧情梗概”。
   - **L3 印象层**: 将事件进一步提炼为长效事实，存储于 ChromaDB 向量数据库，通过语义检索动态注入上下文。

3. **API 与接口 (API & Interfaces)**
   - 提供基于 Fastify 的 HTTP 初始化接口与 WebSocket 实时聊天入口。
   - 提供专属的 Debug WebSocket 通道，实时输出 Agent 思考流 (Thought / Action / Observation)。

4. **便捷脚本与分发**
   - 新增 `install.sh` 一键环境配置脚本。
   - 支持作为 `npm` 包全局安装，提供 `alive-buddy` 快捷命令启动服务。

## 📝 许可协议 (License)
本项目采用 **MIT** 协议开源。
