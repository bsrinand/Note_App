@echo off
title Inkwell
cd /d "%~dp0"
echo Starting Inkwell...
start "" http://localhost:4321
node server.js
pause
