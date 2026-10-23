@echo off
rem ------------------------------------------------------------------
rem  Bridge Observatory - LAN start via Node.js  (recommended path
rem  when a phone or tablet must open the project)
rem
rem    Binds 0.0.0.0 and prints the addresses to type on the phone.
rem    Windows may ask about the firewall the first time - choose Allow.
rem    No admin shell is required: the prompt comes from Windows itself.
rem
rem    Keep this window open while students browse; closing it stops
rem    the server immediately.
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
echo   Bridge Observatory - LAN mode
echo.
echo   The addresses to open on the phone are listed below.
echo   Same Wi-Fi is required. Allow the firewall if Windows asks.
echo   Close this window to stop the server.
echo.

node server.js --lan

pause >nul
exit /b 0

:no_node
echo.
echo   [X] Node.js not found.
echo.
echo   Option 1 - install Node.js 18+ from https://nodejs.org and run this again.
echo   Option 2 - double-click the phone / LAN launcher exe in this folder.
echo.
pause
exit /b 1
