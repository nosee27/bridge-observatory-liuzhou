@echo off
rem ------------------------------------------------------------------
rem  Add inbound firewall rules so a phone on the same Wi-Fi can reach
rem  the local server.
rem
rem  Why this is needed: Windows matches inbound rules by "program +
rem  network profile". A common trap is a node.exe rule that only covers
rem  the Public profile while the home Wi-Fi is Private - the phone then
rem  gets silently dropped and the browser just says "can't connect".
rem
rem  ASCII-only on purpose (cmd reads .bat in the OEM codepage).
rem ------------------------------------------------------------------
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Administrator rights required - requesting elevation ...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo   Adding inbound firewall rules ...
echo.

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"

if defined NODE_EXE (
  netsh advfirewall firewall delete rule name="Bridge Observatory (node)" >nul 2>&1
  netsh advfirewall firewall add rule name="Bridge Observatory (node)" dir=in action=allow program="%NODE_EXE%" enable=yes profile=any >nul
  echo   [OK] node.exe  -^> %NODE_EXE%
) else (
  echo   [SKIP] node.exe not found
)

set "LAUNCHER="
for %%f in ("%~dp0*.exe") do if not defined LAUNCHER set "LAUNCHER=%%~ff"

if defined LAUNCHER (
  netsh advfirewall firewall delete rule name="Bridge Observatory (exe)" >nul 2>&1
  netsh advfirewall firewall add rule name="Bridge Observatory (exe)" dir=in action=allow program="%LAUNCHER%" enable=yes profile=any >nul
  echo   [OK] %LAUNCHER%
) else (
  echo   [SKIP] launcher exe not found
)

netsh advfirewall firewall delete rule name="Bridge Observatory (port)" >nul 2>&1
netsh advfirewall firewall add rule name="Bridge Observatory (port)" dir=in action=allow protocol=TCP localport=4173-4212 profile=any >nul
echo   [OK] TCP 4173-4212

echo.
echo   Done. Next:
echo     1. run start-mobile.bat
echo     2. on the phone, open the address shown in the dialog
echo        (looks like http://192.168.x.x:4173)
echo.
echo   To undo:
echo     netsh advfirewall firewall delete rule name="Bridge Observatory (node)"
echo     netsh advfirewall firewall delete rule name="Bridge Observatory (exe)"
echo     netsh advfirewall firewall delete rule name="Bridge Observatory (port)"
echo.
pause >nul
endlocal
