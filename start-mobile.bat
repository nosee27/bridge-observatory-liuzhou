@echo off
rem ------------------------------------------------------------------
rem  Bridge Observatory - mobile / LAN mode.
rem
rem  Keep this file ASCII-only: cmd.exe reads .bat in the OEM codepage,
rem  so Chinese characters (incl. the launcher's Chinese file name) get
rem  mangled and the "if exist" check silently fails. The launcher is
rem  therefore resolved with a wildcard instead of being spelled out.
rem ------------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo.
echo   Bridge Observatory - mobile / LAN mode
echo.
echo   Use the SAME Wi-Fi on the phone. If Windows asks about the
echo   firewall, choose Allow. A dialog will show the address to type.
echo.
echo   Close this window (or the app window) to stop the server.
echo.

set "LAUNCHER="
for %%f in ("%~dp0*.exe") do if not defined LAUNCHER set "LAUNCHER=%%~ff"

if defined LAUNCHER (
  "%LAUNCHER%" --lan
  goto :done
)

echo   Launcher not found; falling back to Node.js ...
echo.
node server.js --lan

:done
pause >nul
endlocal
