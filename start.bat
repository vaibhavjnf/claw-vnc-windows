@echo off
cd /d C:\Users\user\Desktop\claw-vnc
set CLAW_TOKEN=vaibhavclaw
set ANTHROPIC_API_KEY=your_key_here
set BIND_HOST=0.0.0.0
node server.js
