@echo off
rem Yogurt Shell - start panel in background (no console window)
rem All messages come from the Node helper (UTF-8 safe); this file stays ASCII-only.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [yogurt-shell] Node.js not found. Install Node.js 18+ first: https://nodejs.org/
  pause
  exit /b 1
)

node scripts\start-background.js %*
set "CODE=%errorlevel%"

if "%CODE%"=="0" (
  rem open the panel in the default browser
  for /f "usebackq tokens=1,2" %%a in (`node scripts\panel-info.js`) do (
    start "" "http://%%b:%%a/"
  )
) else (
  pause
)
exit /b %CODE%
