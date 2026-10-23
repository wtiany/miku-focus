@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.9 or newer: https://nodejs.org/
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
call npm run share
pause
