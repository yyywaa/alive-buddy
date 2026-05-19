# alive-buddy 🤖

*alive-buddy* 是一个基于机器学习决策树与 reAct 循环的**自主行动智能体 (Autonomous Agent)** 框架。

它不同于传统的静态聊天机器人，它拥有自己的“主观时间感”和“心理状态”，能够根据精力、无聊度等特征，自发地产生行动冲动。

## 🌟 核心特性

- **ML 驱动的唤醒机制**：采用 `RandomForestRegressor` 替代传统的固定规则，模拟人类的社交欲望与生物节奏。
- **ReAct 思考循环**：支持“内部独白”与“外部行动”分离，模拟真实人脑的决策过程。
- **三层记忆架构**：结合 SQLite (L1/L2) 与 ChromaDB (L3 RAG)，实现长期运行不忘事的记忆力。
- **实时性与中断**：内置物理级 Abort 机制，支持用户随时插话，智能体能立即中断思考并响应。
- **双引擎架构**：TS 处理高并发 API 与逻辑调度，Python 支撑 ML 推理与蒸馏流水线。

## 🏗️ 架构概览

```text
[用户/聊天室] <-> [WebSocket API] <-> [Character 引擎]
                                          |
                   -------------------------------------------
                   |                      |                  |
           [reAct 循环]            [决策树 (ML)]       [三层记忆]
           (LLM 调用)              (Python Sidecar)    (SQLite/VectorDB)
```

## 🚀 快速开始

### 1. 环境准备
确保已安装 Node.js (v20+) 和 Python (3.10+)。

### 2. 安装依赖
```bash
npm install
pip install -r requirements.txt
```

### 3. 配置与运行
修改 `src/index.ts` 中的配置，然后启动开发服务器：
```bash
npm run dev
```

## 📂 项目结构
请参考 [docs/PLAN.md](docs/PLAN.md) 获取详细的模块说明与开发计划。

## 🤝 贡献与反馈
本项目目前处于早期原型阶段，欢迎通过 Issues 提交你的点子。

---
**License**: MIT  
**Author**: yyywaa (951899550@qq.com)
