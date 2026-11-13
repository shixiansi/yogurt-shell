@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [yogurt-shell] Node.js not found. Install Node.js 18+ first: https://nodejs.org/
  pause
  exit /b 1
)
node server.js %*
echo.
echo [yogurt-shell] panel exited. Press any key to close.
pause >nul
