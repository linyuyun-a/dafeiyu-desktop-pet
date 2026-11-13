@echo off
rem DeepSeek desktop pet launcher (ASCII-only file name on purpose).
rem 1) clear ELECTRON_RUN_AS_NODE, or Electron runs as plain Node and exits
rem    with "does not provide an export named 'BrowserWindow'"
rem 2) go through cmd (not straight from the .lnk) so SmartScreen skips the
rem    unsigned electron.exe
setlocal
set "ELECTRON_RUN_AS_NODE="
set "PET_ROOT=%~dp0"
if "%PET_ROOT:~-1%"=="\" set "PET_ROOT=%PET_ROOT:~0,-1%"
cd /d "%PET_ROOT%"

if not exist "%PET_ROOT%\node_modules\electron\dist\electron.exe" (
  echo [ERROR] node_modules\electron\dist\electron.exe not found
  echo run: npm install
  pause
  exit /b 1
)

start "deepseek-pet" "%PET_ROOT%\node_modules\electron\dist\electron.exe" "%PET_ROOT%"
exit /b 0
