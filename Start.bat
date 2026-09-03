@echo off
pushd %~dp0
set NODE_ENV=production
set "STARTUP_TIMING=false"
findstr /R /C:"^enableStartupTiming:[ ]*true" config.yaml >nul 2>&1 && set "STARTUP_TIMING=true"
if /I "%STARTUP_TIMING%"=="true" echo [startup] %date% %time% Starting dependency check...
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
set "NPM_EXIT_CODE=%errorlevel%"
if /I "%STARTUP_TIMING%"=="true" echo [startup] %date% %time% Dependency check finished with exit code %NPM_EXIT_CODE%.
if /I "%STARTUP_TIMING%"=="true" echo [startup] %date% %time% Starting Node server...
set "NODE_SCRIPT=server.js"
if /I "%STARTUP_TIMING%"=="true" set "NODE_SCRIPT=scripts\profile-startup.mjs"
node %NODE_SCRIPT% %*
set "NODE_EXIT_CODE=%errorlevel%"
if /I "%STARTUP_TIMING%"=="true" echo [startup] %date% %time% Node server exited with exit code %NODE_EXIT_CODE%.
pause
popd
