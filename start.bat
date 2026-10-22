@echo off
setlocal
cd /d "%~dp0"
echo.
echo   Bridge Observatory - local server
echo   URL: http://127.0.0.1:4173
echo.
echo   The 3D scene requires http:// (not file://).
echo   Close this window to stop the server.
echo.

start /b "" node server.js
ping -n 3 127.0.0.1 >nul
start "" "http://127.0.0.1:4173"

pause >nul
endlocal
