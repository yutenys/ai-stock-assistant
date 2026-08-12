@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please install Node.js first.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

call npm start
