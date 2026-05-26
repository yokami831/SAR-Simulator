@echo off
REM HiyoCanvas launcher
REM Electron manages FastAPI + terminal-server + BrowserWindow.

echo ============================================
echo   HiyoCanvas - Starting...
echo ============================================
echo.

cd /d "%~dp0"

REM Show versions for troubleshooting
python --version 2>nul
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.10+.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js not found. Please install Node.js 18+.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo Node.js %%v

REM Detect first-run (no .venv AND no node_modules)
set "FIRST_RUN=0"
if not exist .venv set "FIRST_RUN=1"
if not exist node_modules set "FIRST_RUN=1"
if "%FIRST_RUN%"=="1" (
    echo.
    echo   First-time setup - this may take a few minutes...
    echo.
)

REM Setup venv if not exists
if not exist .venv (
    echo Creating virtual environment...
    python -m venv .venv
    call .venv\Scripts\activate.bat
    pip install -r requirements.txt
    if errorlevel 1 (
        echo ERROR: pip install failed.
        pause
        exit /b 1
    )
) else (
    call .venv\Scripts\activate.bat
)

REM Install npm dependencies if needed
if not exist node_modules (
    echo Installing npm dependencies...
    npm install
    if errorlevel 1 (
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
)

REM Build frontend if dist/ doesn't exist
if not exist dist (
    echo Building frontend...
    call npm run build
    if errorlevel 1 (
        echo ERROR: Frontend build failed.
        pause
        exit /b 1
    )
)

echo.
echo   Electron manages all processes.
echo   Close the window to stop.
echo ============================================
echo.

REM Clear ELECTRON_RUN_AS_NODE (VSCode sets this, which breaks Electron)
set "ELECTRON_RUN_AS_NODE="

REM Launch Electron (blocks until window closes)
npx electron .
