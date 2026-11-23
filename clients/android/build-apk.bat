@echo off
rem 一键构建安卓调试版 APK（需要：Node.js 18+、JDK 17、Android SDK，并设置好 ANDROID_HOME）
setlocal
cd /d "%~dp0"
if "%ANDROID_HOME%"=="" if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if "%ANDROID_HOME%"=="" (echo 没有找到 Android SDK，请先安装 Android Studio 或设置 ANDROID_HOME & exit /b 1)
call npm install --no-audit --no-fund || exit /b 1
if not exist android call npx cap add android || exit /b 1
node prepare.cjs || exit /b 1
call npx cap sync android || exit /b 1
set "SDKP=%ANDROID_HOME:\=/%"
> android\local.properties echo sdk.dir=%SDKP%
pushd android
call gradlew.bat assembleDebug || (popd & exit /b 1)
popd
echo.
echo 完成：android\app\build\outputs\apk\debug\app-debug.apk
