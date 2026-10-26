@echo off
setlocal
cd /d "%~dp0app"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.9 or newer first.
  pause
  exit /b 1
)
set "MIKU_NEEDS_INSTALL="
if not exist "node_modules\ws\package.json" set "MIKU_NEEDS_INSTALL=1"
if not exist "node_modules\qrcode\package.json" set "MIKU_NEEDS_INSTALL=1"
if defined MIKU_NEEDS_INSTALL (
  call npm ci --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Your browser will open automatically after the server starts.
set "MIKU_OPEN_BROWSER=1"
call npm start
pause
