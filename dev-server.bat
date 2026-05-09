@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动开发服务器（保存代码后会自动重启）...
echo 关闭本窗口即停止服务。
call npm run dev
pause
