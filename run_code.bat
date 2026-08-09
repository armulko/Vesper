@echo off
title Vesper Launcher

cd /d "%~dp0"

:start
cls
echo ========================================
echo          VESPER AI LAUNCHER
echo ========================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    pause
    exit /b
)

echo [INFO] Starting Vesper...
echo.

python app.py

echo.
echo [WARN] Vesper stopped or crashed.
echo Restarting in 3 seconds...
timeout /t 3 >nul

goto start