#!/usr/bin/env bash

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}>>> 正在准备安装 alive-buddy 环境...${NC}"

# 1. 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}[错误] 未检测到 Node.js，请安装 Node.js v20 或以上版本。${NC}"
    exit 1
fi
NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${YELLOW}[警告] Node.js 版本低于 v20 (当前版本: $(node -v))，可能存在兼容性问题。${NC}"
else
    echo -e "${GREEN}[OK] Node.js 版本: $(node -v)${NC}"
fi

# 2. 检查 Python
PYTHON_CMD=""
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
else
    echo -e "${RED}[错误] 未检测到 Python，请安装 Python 3.10 或以上版本。${NC}"
    exit 1
fi

PY_VERSION=$($PYTHON_CMD -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
if $(awk 'BEGIN {print ('$PY_VERSION' < 3.10)}') ; then
    echo -e "${YELLOW}[警告] Python 版本低于 3.10 (当前版本: $PY_VERSION)，可能存在兼容性问题。${NC}"
else
    echo -e "${GREEN}[OK] Python 版本: $PY_VERSION${NC}"
fi

# 3. 安装 Node 依赖
echo -e "\n${GREEN}>>> 正在安装 Node.js 依赖 (npm install)...${NC}"
npm install

# 4. 安装 Python 依赖
echo -e "\n${GREEN}>>> 正在安装 Python 依赖 (pip install -r requirements.txt)...${NC}"
if command -v pip3 &> /dev/null; then
    pip3 install -r requirements.txt
else
    pip install -r requirements.txt
fi

# 5. 配置环境变量文件
echo -e "\n${GREEN}>>> 正在配置环境变量...${NC}"
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${GREEN}[OK] 已基于 .env.example 自动生成 .env 文件，请记得修改其中的 API KEY 等配置！${NC}"
    else
        echo -e "${YELLOW}[警告] 未找到 .env.example 文件，跳过生成 .env。${NC}"
    fi
else
    echo -e "${GREEN}[OK] 检测到已存在 .env 文件，跳过生成。${NC}"
fi

echo -e "\n${GREEN}==========================================${NC}"
echo -e "${GREEN}安装完成！${NC}"
echo -e "后续运行步骤："
echo -e "1. 修改 ${YELLOW}.env${NC} 文件中的配置（如 OPENAI_API_KEY）"
echo -e "2. 启动 ML Sidecar: ${YELLOW}cd src/ml && python app.py${NC}"
echo -e "3. 新开终端启动主服务: ${YELLOW}npm run dev${NC}"
echo -e "${GREEN}==========================================${NC}"
