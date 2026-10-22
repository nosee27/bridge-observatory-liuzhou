@echo off
setlocal
cd /d "%~dp0"
echo.
echo   Bridge Observatory - LAN mode (for phones / tablets)
echo.
echo   Keep this window open while students browse.
echo   Same Wi-Fi is required. Windows may ask for firewall permission - choose Allow.
echo.

node server.js --lan

pause >nul
endlocal
