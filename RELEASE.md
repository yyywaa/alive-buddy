# Release v0.0.0

alive-buddy 的第一个早期原型。

这个版本搭好了主框架：智能体可以通过 reAct 循环被动回复用户，也能基于 RandomForest 决策树主动发消息。记忆做了三层：SQLite 存近期对话，ChromaDB 存长期印象。API 用 Fastify 提供，支持 WebSocket 聊天和 Debug 日志流。

主要模块：

- `src/brain`: reAct 引擎、Character 类、主动决策模块
- `src/memory`: SQLite 和 ChromaDB 接入
- `src/ml`: Python 决策树 sidecar
- `src/api`: Fastify HTTP/WebSocket 服务

安装可以直接跑 `./install.sh`，装完后用 `alive-buddy` 命令启动。

License: MIT
