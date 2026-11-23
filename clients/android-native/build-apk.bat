@echo off
rem 一键构建安卓原生版（Kotlin + Jetpack Compose）调试 APK
rem 需要：JDK 17、Android SDK（安装 Android Studio 即可）。第一次构建要联网下载依赖，约几分钟。
setlocal
cd /d "%~dp0"
if "%ANDROID_HOME%"=="" if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if "%ANDROID_HOME%"=="" (echo 没有找到 Android SDK，请先安装 Android Studio 或设置 ANDROID_HOME & exit /b 1)
set "SDKP=%ANDROID_HOME:\=/%"
> local.properties echo sdk.dir=%SDKP%
call gradlew.bat assembleDebug || exit /b 1
echo.
echo 完成：app\build\outputs\apk\debug\app-debug.apk
