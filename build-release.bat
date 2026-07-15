@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo ==============================================
echo  Minecraft CaYa Bot Panel - Release olusturucu
echo ==============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo HATA: Node.js PATH'te yok.
  pause
  exit /b 1
)

REM --- Mevcut surum ---
for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set "CUR=%%V"
if not defined CUR set "CUR=0.0.0"
echo  Mevcut surum: %CUR%
echo.

REM --- Surum: 1. arguman veya sor ---
set "VERSION=%~1"
if "!VERSION!"=="" (
  set /p "VERSION=Surum gir (ornek: 1.0.0) [%CUR%]: "
)
if "!VERSION!"=="" set "VERSION=%CUR%"

REM basindaki v kaldir, bosluk sil
if /i "!VERSION:~0,1!"=="v" set "VERSION=!VERSION:~1!"
set "VERSION=!VERSION: =!"

echo.
echo  Hedef surum: !VERSION!
echo.

REM Node -e icinde ! karakteri delayed-expansion bozar — ayri script kullan
echo [1/4] package.json surumleri guncelleniyor...
call node "%~dp0scripts\set-version.mjs" "!VERSION!"
if errorlevel 1 (
  echo HATA: Surum yazilamadi.
  pause
  exit /b 1
)

echo.
echo [2/4] npm run dist:win  (build + NSIS + portable^)
echo.
call npm run dist:win
if errorlevel 1 (
  echo.
  echo HATA: Build basarisiz.
  pause
  exit /b 1
)

echo.
echo ==============================================
echo  Yerel paket hazir
echo ==============================================
if exist "dist-electron" (
  dir /b "dist-electron\*.exe" 2>nul
) else (
  echo  dist-electron klasoru yok!
)
echo.

set "DO_GH="
set /p "DO_GH=GitHub Release olusturulsun mu? (tag v!VERSION!) [E/H]: "
if /i not "!DO_GH!"=="E" if /i not "!DO_GH!"=="Y" (
  echo.
  echo GitHub atlandi. Surum dosyalari guncellendi.
  echo Ciktilar: dist-electron\
  pause
  exit /b 0
)

where gh >nul 2>&1
if errorlevel 1 (
  echo HATA: gh CLI yok. https://cli.github.com
  pause
  exit /b 1
)

echo.
echo [3/4] Git commit + tag v!VERSION!

git add package.json server/package.json web/package.json
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "chore(release): v!VERSION!"
) else (
  echo   Commit atlanacak ^(staged degisiklik yok^).
)

git rev-parse "refs/tags/v!VERSION!" >nul 2>&1
if errorlevel 1 (
  git tag -a "v!VERSION!" -m "Minecraft CaYa Bot Panel v!VERSION!"
  if errorlevel 1 (
    echo HATA: Tag olusturulamadi.
    pause
    exit /b 1
  )
  echo   Tag olusturuldu: v!VERSION!
) else (
  echo   Tag zaten var: v!VERSION!
)

set "DO_PUSH="
set /p "DO_PUSH=git push + tag gonderilsin mi? [E/H]: "
if /i "!DO_PUSH!"=="E" goto :push
if /i "!DO_PUSH!"=="Y" goto :push
echo Push atlandi.
goto :release

:push
echo.
git push origin HEAD
if errorlevel 1 (
  echo HATA: branch push basarisiz.
  pause
  exit /b 1
)
git push origin "v!VERSION!"
if errorlevel 1 (
  echo HATA: tag push basarisiz.
  pause
  exit /b 1
)

:release
echo.
echo [4/4] GitHub Release...
call node "%~dp0scripts\create-github-release.mjs" "!VERSION!"
if errorlevel 1 (
  echo HATA: GitHub release basarisiz.
  pause
  exit /b 1
)

echo.
echo ==============================================
echo  Bitti: v!VERSION!
echo  Yerel : dist-electron\
echo  GitHub: https://github.com/CaYatur/Minecraft-CaYa-Bot-Panel/releases/tag/v!VERSION!
echo ==============================================
pause
exit /b 0
