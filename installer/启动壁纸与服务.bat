@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PS=%~dp0Nientum_Bridge\setup\installer.ps1"
if not exist "%PS%" (
  echo [错误] 缺少 Nientum_Bridge\setup\installer.ps1，请确认文件完整。
  pause
  exit /b 1
)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%PS%" -Mode start
if errorlevel 1 pause
