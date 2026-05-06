#!/bin/bash

# 漫展排队系统启动脚本
cd /Users/bawangchaji/Documents/课程/kaifa/comiccon-queue/backend

# 检查是否已安装依赖
if [ ! -d "node_modules" ]; then
    echo "正在安装依赖..."
    npm install
fi

# 启动服务器
echo "正在启动漫展排队系统..."
echo "服务器地址: http://localhost:3000/admin"
echo "默认账号: admin / admin123"
echo "按 Ctrl+C 停止服务器"
node server.js