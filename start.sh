#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend"

LAN_IP="${LAN_IPV4:-172.16.102.3}"
PORT="${PORT:-3000}"

# 检查是否已安装依赖
if [ ! -d "node_modules" ]; then
    echo "正在安装依赖..."
    npm install
fi

echo "正在启动漫展排队系统..."
echo "本机管理后台:   http://localhost:${PORT}/admin/"
echo "局域网管理后台: http://${LAN_IP}:${PORT}/admin/"
echo "默认账号: admin / admin123"
echo "按 Ctrl+C 停止服务器"
node server.js