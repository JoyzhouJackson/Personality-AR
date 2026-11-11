@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONDONTWRITEBYTECODE=1"
python "%~dp0run.py"
if errorlevel 1 (
    pause
    exit /b 1
)
start "" "%~dp0outputs\static-schedule.html"
