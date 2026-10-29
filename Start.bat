@echo off
setlocal
pushd "%~dp0" || exit /b 1
set NODE_ENV=production
set "STARTUP_TIMING=false"
findstr /R /C:"^enableStartupTiming:[ ]*true" config.yaml >nul 2>&1 && set "STARTUP_TIMING=true"
if /I "%STARTUP_TIMING%"=="true" echo [startup] %date% %time% Starting dependency check...
node scripts\ensure-dependencies.mjs
set "NPM_EXIT_CODE=%errorlevel%"
if /I "%STARTUP_TIMING%"=="true" echo [startup] %date% %time% Dependency check finished with exit code %NPM_EXIT_CODE%.
if not "%NPM_EXIT_CODE%"=="0" (
    echo Dependency installation failed. Server startup cancelled.
    pause
    popd
    exit /b %NPM_EXIT_CODE%
)
if /I "%STARTUP_TIMING%"=="true" echo [startup] %date% %time% Starting Node server...
set "NODE_SCRIPT=server.js"
if /I "%STARTUP_TIMING%"=="true" set "NODE_SCRIPT=scripts\profile-startup.mjs"
node "%NODE_SCRIPT%" %*
set "NODE_EXIT_CODE=%errorlevel%"
if /I "%STARTUP_TIMING%"=="true" echo [startup] %date% %time% Node server exited with exit code %NODE_EXIT_CODE%.
pause
popd
exit /b %NODE_EXIT_CODE%
