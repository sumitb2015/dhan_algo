@echo off
setlocal enabledelayedexpansion

echo ============================================
echo  Pulling latest changes from master...
echo ============================================
call git -C "C:\dhan_algo\dhan_algo" pull origin master
if errorlevel 1 (
    echo.
    echo git pull failed. Aborting startup.
    pause
    exit /b 1
)

cd /d "C:\dhan_algo\dhan_algo\rs_dashboard"

echo.
echo ============================================
echo  Stopping any process on port 3000...
echo ============================================
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R ":3000[^0-9]" ^| findstr "LISTENING"') do (
    echo Killing PID %%P
    taskkill /F /PID %%P >nul 2>&1
    set FOUND=1
)
if !FOUND!==0 (
    echo No process was listening on port 3000.
) else (
    echo Done.
)

echo.
echo ============================================
echo  Running: npm run build
echo ============================================
call npm run build
if errorlevel 1 (
    echo.
    echo Build failed. Aborting startup.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Starting application: npm start
echo ============================================
call npm start

pause



