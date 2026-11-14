@echo off
rem Yogurt Shell - stop panel gracefully (stops accounts first)
rem Messages come from the Node helper; this file stays ASCII-only.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [yogurt-shell] Node.js not found. Install Node.js 18+ first: https://nodejs.org/
  pause
  exit /b 1
)

node scripts\stop-panel.js
set "CODE=%errorlevel%"
if not "%CODE%"=="0" echo [yogurt-shell] stop failed with code %CODE%
ping -n 3 127.0.0.1 >nul 2>&1
exit /b %CODE%
