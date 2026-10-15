@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org ^(the LTS button^), then run this file again.
  start https://nodejs.org
  pause
  exit /b
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
