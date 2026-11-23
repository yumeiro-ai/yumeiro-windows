# Yumeiro 苹果原生客户端（iPhone / iPad / Mac）

SwiftUI 写的原生界面，一份代码同时出 **iOS（iPhone + iPad）** 和 **macOS** 两个 App，功能和安卓原生版对齐：

- 登录（服务器地址、邮箱、密码；自签名证书可勾“忽略证书错误”；没写 http/https 时先试 https，不行自动改 http）；会话 Cookie 和令牌存在钥匙串里
- 对话列表按日期分组、重命名、删除、复制整段对话；流式回复 + Markdown（标题、列表、引用、代码块可复制）
- 选模型；图片（相册）和文件（PDF/Word/Excel/文本…）附件，带上传进度，可取消，点开查看
- 设置：账号与用量、修改密码、默认模型、新对话用的智能体、记忆、外观（深色/浅色/跟随系统、壁纸、遮罩、字体大小）
- 智能体、技能的新建/编辑/删除；技能市场浏览、预览、一键安装；点名称看说明，英文可一键翻译成中文
- 管理员：网页找回密码确认（输入网页上显示的 6 位验证码，批准/拒绝）；成员（添加、停用、重置密码、删除）、全员用量、MCP 服务开关
- 壁纸和网页、Windows、安卓共用服务器上的设置

> ⚠️ **这套代码是在 Windows 上写的，没有在 Xcode 里编译过，也没有在 iPhone / Mac 上运行过。**
> 第一次在 Xcode 里编译很可能还要修一些小的编译错误（SwiftUI 版本差异、拼写等）。遇到报错把信息发给我就行。

## 没有 Mac？用 GitHub Actions 在云端编译
仓库里带了一个工作流 `apple-build.yml`，会在 GitHub 的 macOS 云机器上用 XcodeGen 生成工程并编译 iOS 和 macOS 两个 target，把**编译报错整理出来**（只检查能不能编译，不签名、不打包）。
1. 新建一个 GitHub 仓库（私有也行；公开仓库的 Actions 免费，私有仓库有免费额度，macOS 分钟数按 10 倍计）。
2. 把代码推上去，二选一：
   - 整个项目当仓库：根目录的 `.github/workflows/apple-build.yml` 会生效（`.gitignore` 已排除 data、secrets、.env、node_modules）；
   - 只传 `clients/apple` 这个文件夹：它里面也带了一份 `.github/workflows/apple-build.yml`。
3. 打开仓库的 **Actions → Apple build check → Run workflow**（推送改动 `clients/apple/**` 时也会自动跑）。
4. 看结果：点进运行记录，页面顶部的 **Summary** 里有每个 target 的“✅编译通过”或“❌错误列表”；完整日志在页面底部 Artifacts 里下载。把错误列表发给我就能逐个修。

## 需要什么
- 一台 Mac，装好 **Xcode 15 或更新**（iOS 17 / macOS 14 起）
- [XcodeGen](https://github.com/yonaskolb/XcodeGen)：`brew install xcodegen`
- 真机运行 / 打包需要 Apple ID（免费账号可以自己的设备上试用，7 天有效；上架 App Store 或做长期分发需要付费的开发者账号）

## 生成工程并运行
```bash
cd clients/apple
xcodegen generate          # 生成 Yumeiro.xcodeproj
open Yumeiro.xcodeproj
```
1. 左上角选 **Yumeiro-iOS**（模拟器 / 你的 iPhone）或 **Yumeiro-macOS**（My Mac）。
2. 在 *Signing & Capabilities* 里选你自己的 Team（首次需要登录 Apple ID）。如果 `org.yumeiro.app` 被占用，把 Bundle Identifier 改成你自己的，比如 `com.你的名字.yumeiro`。
3. ⌘R 运行。登录页填你的服务器地址即可（模拟器访问本机服务用 `http://localhost:端口`）。

## 打包
- **Mac App**：Xcode → Product → Archive → Distribute App → *Copy App* 得到 `Yumeiro.app`（自己用）；要给别人用建议做 Developer ID 签名 + 公证。
- **iPhone**：Archive 后 *Distribute App*：Ad Hoc / TestFlight / App Store 都需要付费开发者账号。
- 图标目前用的是 256×256 的占位图（`Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png`），正式上架前请换成 1024×1024 的图。

## 和服务器的关系
只用服务器已有的接口（登录、对话、流式聊天、附件、模型、智能体、技能、市场、记忆、壁纸、管理等），翻译用服务器新增的 `/api/translate`（服务器 0.42.0 起）。

## 代码结构
```
Sources/Shared/
  Api.swift          网络层（Cookie/CSRF、SSE 流式、上传进度、自签名证书）
  AppModel.swift     全部状态和业务逻辑
  Models.swift       数据结构
  RootViews.swift    根视图、登录、壁纸背景
  MainViews.swift    侧栏、聊天、输入框、附件
  Markdown.swift     Markdown 渲染
  SettingsViews.swift 设置、选项弹窗、说明弹窗（带翻译）
  ManageViews.swift  智能体、技能、市场、管理
project.yml          XcodeGen 配置（两个 target：Yumeiro-iOS / Yumeiro-macOS）
```

## 0.46.1（版本号现在和服务端统一）

- 壁纸只保存在这台设备上（本机图片 / 内置渐变 / 服务器壁纸库里的某一张），不再读写服务器账号里的壁纸偏好，也不跟随服务器默认壁纸。
- 管理员可以在“管理”里改成员、安全与熔断、套餐信息、模型价格和站点设置（服务器端设置，对所有人生效）。
- 本版没有在 Xcode 里编译过，请在 Mac 上编译确认。
