@echo off
setlocal

echo ========================================================================================================================
echo Tailscale Remote Access for SillyTavern
echo ========================================================================================================================
echo This script helps you connect to SillyTavern remotely via Tailscale.
echo Tailscale creates a private, encrypted mesh network between your devices.
echo.
echo Prerequisites:
echo   1. Install Tailscale: https://tailscale.com/download
echo   2. Install Tailscale on your remote device (phone, laptop, etc.)
echo   3. Sign in with the same account on both devices
echo   4. Set "listen: true" in config.yaml
echo   5. Add your Tailscale IP range (100.0.0.0/8) to the whitelist in config.yaml,
echo      or disable whitelistMode
echo ========================================================================================================================
echo.

REM -- Find Tailscale CLI --
set "TAILSCALE=tailscale"
where tailscale >nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\Tailscale\tailscale.exe" (
        set "TAILSCALE=C:\Program Files\Tailscale\tailscale.exe"
    ) else (
        echo [ERROR] Tailscale CLI not found.
        echo.
        echo Install Tailscale from: https://tailscale.com/download/windows
        echo.
        pause
        exit /b 1
    )
)

REM -- Check Tailscale status --
echo [INFO] Checking Tailscale status...
"%TAILSCALE%" status >nul 2>&1
if errorlevel 1 (
    echo [WARN] Tailscale is not connected. Attempting to connect...
    "%TAILSCALE%" up
    if errorlevel 1 (
        echo [ERROR] Failed to connect to Tailscale. Please check your Tailscale installation.
        pause
        exit /b 1
    )
)

REM -- Get Tailscale IP --
echo.
echo [INFO] Tailscale is connected.
echo.
for /f "usebackq tokens=*" %%i in (`"%TAILSCALE%" ip -4`) do set "TS_IP=%%i"

if "%TS_IP%"=="" (
    echo [ERROR] Could not determine Tailscale IPv4 address.
    pause
    exit /b 1
)

echo ========================================================================================================================
echo Your SillyTavern remote URL:  http://%TS_IP%:8003
echo ========================================================================================================================
echo.
echo Use this URL on any device connected to your Tailscale network.
echo The connection is encrypted end-to-end and does NOT expose your server to the public internet.
echo.
echo Press any key to open Tailscale status dashboard...
pause >nul
"%TAILSCALE%" status

echo.
pause
endlocal