# Yumeiro 安卓客户端（Capacitor 外壳）

> **状态：已构建 APK，并在 Android 14 模拟器（x86_64）里实际运行验证。** 流程：安装 → 启动 → 在入口页输入服务器地址 → **在应用内**加载登录页（没有跳到外部浏览器）→ 登录接口可用 → 能打开 `/remote` 远程控制页。成品见仓库外 `Yumeiro-Clients\Yumeiro-android-debug.apk`。
> **注意：这是调试签名的 APK**，可以直接侧载安装；不能上架应用商店。正式发布需要用你自己的密钥签名（见下）。
> 没验证到的：真机（尤其是各家厂商 ROM）、麦克风实际录音、触摸手势、HTTPS 自签名证书场景。

## 安装
把 APK 传到手机，打开安装（需允许“安装未知来源应用”）；或 `adb install -r Yumeiro-android-debug.apk`。首次打开输入服务器地址即可，之后自动进入。想换服务器：清除应用数据。

**服务器建议用 HTTPS**：语音输入 / 通话、PWA 等能力要求“安全环境”。用 `http://局域网地址` 也能登录和聊天，但浏览器会判定为不安全环境，麦克风不可用（本应用已允许明文连接，只为了方便局域网自用，公网请务必 HTTPS）。自签名证书需要先把证书安装到手机。

## 自己构建
需要：Node.js 18+、JDK 17、Android SDK（含 platform 34、build-tools 34）、能访问 npm / Google Maven / Gradle 下载源。
```bat
cd clients\android
build-apk.bat
```
脚本会：`npm install` → `npx cap add android` → `node prepare.cjs`（补上麦克风权限、允许局域网 http、换成 Yumeiro 图标）→ `gradlew assembleDebug`。产物：`android\app\build\outputs\apk\debug\app-debug.apk`。

要点：
- `capacitor.config.json` 里 `allowNavigation: ["*"]` 是必须的：入口页是应用内置页面，之后要跳转到你填的服务器；不允许的话 Capacitor 会把服务器网址丢给外部浏览器。
- 想换成正式签名：用 `keytool -genkeypair` 生成密钥库，再在 Android Studio 里 *Build → Generate Signed Bundle / APK*；密钥库务必自己保管好（丢了就无法更新同一个应用）。
- 想用 Android Studio：`npx cap open android`。

## 另一种：TWA / Bubblewrap
`npm i -g @bubblewrap/cli`，`bubblewrap init --manifest https://你的站点/manifest.webmanifest`，`bubblewrap build`。需要 HTTPS，并在站点根放 `/.well-known/assetlinks.json`（本项目暂未提供）。

## 远程控制电脑
手机上打开 `/remote`（入口页有快捷链接）。手机只是遥控器，被控制的电脑上要运行 `agent.mjs`，见《客户端与远程控制说明.md》。
