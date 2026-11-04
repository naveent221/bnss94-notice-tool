@echo off
rem Starts the BNSS94 mail helper. Keep this window open while you work.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node mail-helper.js %*
pause
