@echo off
cd /d "%~dp0"
set "PORT=4173"
node server.mjs
pause
