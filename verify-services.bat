@echo off
echo --- Fayda Bot Service Connectivity Check ---
echo Checking if MongoDB (27017) is listening...
netstat -ano | findstr :27017
if %errorlevel% equ 0 (
    echo ✅ MongoDB port is open.
) else (
    echo ❌ MongoDB port is NOT open. Ensure MongoDB service is started.
)

echo.
echo Checking if Redis (6379) is listening...
netstat -ano | findstr :6379
if %errorlevel% equ 0 (
    echo ✅ Redis port is open.
) else (
    echo ❌ Redis port is NOT open. Ensure Redis service is started.
)
echo --------------------------------------------
echo TIP: If both are closed, you need to install or start them.
echo For MongoDB: Download from https://www.mongodb.com/try/download/community
echo For Redis: Download Memurai (Windows) from https://www.memurai.com/
echo --------------------------------------------
pause
