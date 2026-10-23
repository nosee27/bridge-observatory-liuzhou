@echo off
rem ------------------------------------------------------------------
rem  Bridge Observatory - LOCAL start via Node.js  (recommended path)
rem
rem    Serves the project on 127.0.0.1 only: nothing is exposed to the
rem    LAN, no firewall change, no admin rights, no unsigned exe.
rem
rem  Requires Node.js 18+. If Node is missing, use the launcher exe in
rem  this folder instead; it bundles the same static server.
rem
rem  NOTE: keep echo lines inside if-blocks free of parentheses and
rem  other cmd metacharacters, otherwise cmd ends the block early and
rem  reports ". was unexpected at this time".
rem  ASCII-only on purpose: cmd reads .bat in the OEM codepage.
rem ------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto :no_node

echo.
echo   Bridge Observatory - local server
echo   URL: http://127.0.0.1:4173
echo.
echo   Bound to 127.0.0.1 only - phones cannot reach this.
echo   For phone access run start-lan.bat instead.
echo   Close this window to stop the server.
echo.

start "" /b node server.js
ping -n 3 127.0.0.1 >nul
start "" "http://127.0.0.1:4173"

pause >nul
exit /b 0

:no_node
echo.
echo   [X] Node.js not found.
echo.
echo   Option 1 - install Node.js 18+ from https://nodejs.org and run this again.
echo   Option 2 - double-click the launcher exe in this folder.
echo              See docs/security-and-signing.md for the prompt explanation.
echo.
pause
exit /b 1
