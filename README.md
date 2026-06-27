# alive-buddy

*alive-buddy* 是一个基于机器学习决策树与 reAct 循环的**自主行动智能体 (Autonomous Agent)** 框架。

它不同于传统的静态聊天机器人，它拥有自己的“主观时间感”和“心理状态”，能够根据精力、无聊度等特征，自发地产生行动冲动。

##  核心特性

- **ML 驱动的唤醒机制**：采用 `RandomForestClassifier` 替代传统的固定规则，模拟人类的社交欲望与生物节奏。
- **ReAct 思考循环**：支持“内部独白”与“外部行动”分离，模拟真实人脑的决策过程。
- **三层记忆架构**：结合 SQLite (L1/L2) 与 ChromaDB (L3 RAG)，实现长期运行不忘事的记忆力。
- **实时性与中断**：内置物理级 Abort 机制，支持用户随时插话，智能体能立即中断思考并响应。
- **双引擎架构**：TS 处理高并发 API 与逻辑调度，Python 支撑 ML 推理与蒸馏流水线。

##  架构概览

```text
[用户/聊天室] <-> [WebSocket API] <-> [Character 引擎]
                                          |
                   -------------------------------------------
                   |                      |                  |
           [reAct 循环]            [决策树 (ML)]       [三层记忆]
           (LLM 调用)              (Python Sidecar)    (SQLite/VectorDB)
```

##  快速开始

### 1. 环境准备
确保已安装 Node.js (v20+) 和 Python (3.10+)。

### 2. 安装依赖
```bash
npm install
pip install -r requirements.txt
```

### 3. 配置环境变量
复制或修改项目根目录的 `.env`，至少填写：
```bash
OPENAI_API_KEY="your-api-key"
OPENAI_BASE_URL="https://api.openai.com/v1"   # 或使用其他兼容 OpenAI 的接口
LLM_MODEL="gpt-4o"

# ML Sidecar 默认端口 8001，避免与 ChromaDB 默认端口 8000 冲突
ML_SIDECAR_URL="http://127.0.0.1:8001"
CHROMA_URL="http://127.0.0.1:8000"
```

### 4. 启动依赖服务

#### 启动 ChromaDB（向量数据库，用于 L3 长期印象）
如果你本地已安装 ChromaDB，可以使用：
```bash
chroma run --path ./data/chroma --port 8000
```
或参考 [Chroma 官方文档](https://docs.trychroma.com/) 使用 Docker 启动。

#### 启动 ML Sidecar（决策树推理服务）
```bash
cd src/ml
python app.py
# 默认监听 127.0.0.1:8001
```

### 5. 运行主服务
```bash
npm run dev
```

主服务启动后会监听 WebSocket 聊天接口，并定时执行 `Character.pulse()` 进行主动决策。

##  接口示例

通过 WebSocket 连接到 `/v1/chat`，发送符合 `UnifiedMessage` 格式的 JSON：
```json
{
  "msg_id": "client-uuid-789012",
  "user_id": "user-888",
  "session_id": "room-101",
  "timestamp": 1716104995000,
  "payload": {
    "role": "user",
    "content": [
      { "type": "text", "text": "在干嘛？" }
    ]
  }
}
```

##  项目结构

请参考 [docs/PLAN.md](docs/PLAN.md) 获取详细的模块说明与开发计划。

##  贡献与反馈

本项目目前处于早期原型阶段，欢迎通过 Issues 提交你的点子。

---
**License**: MIT  
**Author**: yyywaa (951899550@qq.com)
