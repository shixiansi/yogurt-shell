@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [yogurt-shell] 未找到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "data" mkdir "data"

echo [yogurt-shell] 正在后台启动面板…
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:YOGURT_SHELL_LOG='%CD%\data\panel.out.log'; Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden"

timeout /t 4 >nul
echo [yogurt-shell] 已尝试在后台启动，日志：data\panel.out.log
start "" http://127.0.0.1:3090/
