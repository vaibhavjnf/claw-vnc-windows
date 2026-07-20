@echo off
setlocal
cd /d C:\Users\user\Desktop\claw-vnc
if "%CLAW_TOKEN%"=="" (
  echo ERROR: CLAW_TOKEN must be provided by the process environment.
  exit /b 1
)
if "%VNC_PASSWORD%"=="" (
  echo ERROR: VNC_PASSWORD must be provided by the process environment.
  exit /b 1
)
if "%BIND_HOST%"=="" set BIND_HOST=127.0.0.1
node server.js
