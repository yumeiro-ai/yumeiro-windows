; Yumeiro 服务器版 · Windows 安装向导（NSIS）
; 由 scripts/make-windows-installer.mjs 编译：
;   makensis -DVERSION=x.y.z -DSTAGE=<发布包目录> -DPRESETS=<presets.nsh> [-DHAS_CLIENTS=1] -DOUTFILE=<exe> -DLEVEL=admin deploy\windows\installer.nsi
; 向导和 Linux 版的“首次安装”网页向导一一对应：管理员账号 → 组件 → 服务器与存储 → 模型与使用方式 → 其它选项 → 复核。
; 所有选择写进一个临时“答案文件”交给 deploy\yumeiro-windows.ps1 install（密码、数据库地址、API Key 不上命令行；脚本读完就删）。
; 安装时把“装了什么”记下来：卸载向导逐项列出并取消，再问是否同时删除数据。
Unicode true
!ifndef VERSION
  !error "需要 -DVERSION=x.y.z"
!endif
!ifndef STAGE
  !error "需要 -DSTAGE=<发布包目录>"
!endif
!ifndef PRESETS
  !error "需要 -DPRESETS=<模型服务商预设 presets.nsh>"
!endif
!ifndef OUTFILE
  !define OUTFILE "Yumeiro-Server-Setup.exe"
!endif
!ifndef LEVEL
  !define LEVEL "admin"
!endif

!define PRODUCT_NAME "Yumeiro 服务器版"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\YumeiroServer"
!define APP_KEY "Software\Yumeiro"

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!insertmacro GetParameters
!insertmacro GetOptions
!insertmacro un.GetParameters
!insertmacro un.GetOptions

Name "${PRODUCT_NAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "C:\Yumeiro"
RequestExecutionLevel ${LEVEL}
BrandingText "Yumeiro ${VERSION}"
ShowInstDetails show
ShowUninstDetails show
SetCompressor /SOLID lzma
CRCCheck on

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${PRODUCT_NAME} 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Apache License 2.0"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "打开 Yumeiro 管理页面"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenSite
!define MUI_UNCONFIRMPAGE_TEXT_TOP "将卸载 Yumeiro 服务器版。下一页会列出安装时配置的内容，卸载会把它们逐项取消。"

; ---------- 变量 ----------
Var Dialog
Var hA1
Var hA2
Var hA3
Var hA4
Var hA5
Var hA6
Var Email
Var AutoPass
Var AdminPass
Var AdminPass2
Var WithRunner
Var EngClaude
Var EngCodex
Var EngPi
Var EnginesList
Var UseCN
Var Port
Var Domain
Var Access
Var Storage
Var PgUrl
Var ModelPreset
Var ModelUrl
Var ModelName
Var ModelKey
Var Usage
Var Backup
Var WebUpdate
Var Firewall
Var Clients
Var DataRoot
Var NoSvc
Var ResultPath
Var KeepResult
Var Fresh
Var PS
Var Summary
Var AnswersPath
Var AccessText
Var ResUrl
Var ResEmail
Var ResPass
Var ResNote
Var ResScheme
Var Purge
Var hPurge
Var Docker
Var DeskRegion
Var DockerNote
Var NeedReboot

!include "${PRESETS}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom PageAdmin LeaveAdmin
Page custom PageComponents LeaveComponents
Page custom PageServer LeaveServer
Page custom PageModel LeaveModel
Page custom PageOptions LeaveOptions
Page custom PageDocker LeaveDocker
Page custom PageReview
!insertmacro MUI_PAGE_INSTFILES
Page custom PageResult LeaveResult
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.PageCancel un.LeaveCancel
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; ---------- 公共 ----------
Function SetPowerShell
  ${If} ${RunningX64}
    StrCpy $PS "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"   ; 安装程序是 32 位的，要显式用 64 位 PowerShell
  ${Else}
    StrCpy $PS "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
FunctionEnd
Function un.SetPowerShell
  ${If} ${RunningX64}
    StrCpy $PS "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy $PS "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
FunctionEnd
Function OpenSite
  ${If} $ResUrl != ""
    ExecShell "open" "$ResUrl"
  ${Else}
    ExecShell "open" "http://127.0.0.1:$Port/"
  ${EndIf}
FunctionEnd

; 取 /KEY=VALUE 形式的静默参数；没给就保持原值
!macro OPT KEY VAR
  ClearErrors
  ${GetOptions} $R0 "${KEY}" $R1
  ${IfNot} ${Errors}
    StrCpy ${VAR} $R1
  ${EndIf}
!macroend

Function .onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  ; 默认值（和 Linux 向导的默认一致）
  StrCpy $Email "admin@example.com"
  StrCpy $AutoPass 1
  StrCpy $AdminPass ""
  StrCpy $AdminPass2 ""
  StrCpy $WithRunner 0
  StrCpy $EngClaude 1
  StrCpy $EngCodex 1
  StrCpy $EngPi 1
  StrCpy $EnginesList "claude,codex,pi"
  StrCpy $UseCN 0
  StrCpy $Port "8787"
  StrCpy $Domain ""
  StrCpy $Access 0
  StrCpy $Storage 0
  StrCpy $PgUrl ""
  StrCpy $ModelPreset 0
  StrCpy $ModelUrl ""
  StrCpy $ModelName ""
  StrCpy $ModelKey ""
  StrCpy $Usage 0
  StrCpy $Backup 1
  StrCpy $WebUpdate 1
  StrCpy $Firewall 1
  StrCpy $Clients 1
  StrCpy $Docker 0
  StrCpy $DeskRegion 0
  StrCpy $NeedReboot 0
  StrCpy $DockerNote ""
  StrCpy $DataRoot "C:\ProgramData\Yumeiro"
  StrCpy $NoSvc 0
  StrCpy $ResultPath ""
  StrCpy $KeepResult 0
  StrCpy $ResUrl ""
  ; 已安装过：沿用上次的安装目录和数据目录
  ReadRegStr $R2 HKLM "${APP_KEY}" "InstallDir"
  ${If} $R2 != ""
    StrCpy $INSTDIR $R2
    ReadRegStr $R3 HKLM "${APP_KEY}" "DataRoot"
    ${If} $R3 != ""
      StrCpy $DataRoot $R3
    ${EndIf}
  ${EndIf}
  ; 静默 / 无人值守参数。/S /PORT= /EMAIL= /ADMINPASS= /RUNNER=1 /ENGINES=claude,codex,pi /CN=1 /HTTPS=self|domain /DOMAIN= /STORAGE=pg /PGURL=
  ;   /MODELURL= /MODELNAME= /MODELKEY= /PERSONAL=1 /BACKUP=0 /WEBUPDATE=0 /FIREWALL=0 /CLIENTS=0 /DATAROOT= /NOSERVICE=1 /RESULT=文件 /D=安装目录（必须放最后）
  ${GetParameters} $R0
  !insertmacro OPT "/PORT=" $Port
  !insertmacro OPT "/EMAIL=" $Email
  !insertmacro OPT "/DATAROOT=" $DataRoot
  !insertmacro OPT "/DOMAIN=" $Domain
  !insertmacro OPT "/PGURL=" $PgUrl
  !insertmacro OPT "/MODELURL=" $ModelUrl
  !insertmacro OPT "/MODELNAME=" $ModelName
  !insertmacro OPT "/MODELKEY=" $ModelKey
  !insertmacro OPT "/RUNNER=" $WithRunner
  !insertmacro OPT "/ENGINES=" $EnginesList
  !insertmacro OPT "/CN=" $UseCN
  !insertmacro OPT "/BACKUP=" $Backup
  !insertmacro OPT "/WEBUPDATE=" $WebUpdate
  !insertmacro OPT "/FIREWALL=" $Firewall
  !insertmacro OPT "/CLIENTS=" $Clients
  !insertmacro OPT "/DOCKER=" $Docker
  ClearErrors
  ${GetOptions} $R0 "/DESKTOP=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == "global"
      StrCpy $DeskRegion 1
      StrCpy $Docker 1
    ${ElseIf} $R1 == "cn"
      StrCpy $DeskRegion 2
      StrCpy $Docker 1
    ${EndIf}
  ${EndIf}
  !insertmacro OPT "/NOSERVICE=" $NoSvc
  ClearErrors
  ${GetOptions} $R0 "/ADMINPASS=" $R1
  ${IfNot} ${Errors}
    StrCpy $AdminPass $R1
    StrCpy $AutoPass 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/HTTPS=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == "self"
      StrCpy $Access 1
    ${ElseIf} $R1 == "domain"
      StrCpy $Access 2
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/STORAGE=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == "pg"
      StrCpy $Storage 1
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/PERSONAL=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == 1
      StrCpy $Usage 1
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/RESULT=" $R1
  ${IfNot} ${Errors}
    StrCpy $ResultPath $R1
    StrCpy $KeepResult 1
  ${EndIf}
  ClearErrors
FunctionEnd

; ---------- 第 1 步：管理员账号 ----------
Function ToggleAuto
  ${NSD_GetState} $hA3 $R0
  ${If} $R0 == 1
    EnableWindow $hA5 0
    EnableWindow $hA6 0
  ${Else}
    EnableWindow $hA5 1
    EnableWindow $hA6 1
  ${EndIf}
FunctionEnd
Function PageAdmin
  !insertmacro MUI_HEADER_TEXT "管理员账号" "这是登录 Yumeiro 管理后台的本地账号。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 0 0 100% 10u "管理员邮箱（登录用）："
  Pop $0
  ${NSD_CreateText} 0 11u 100% 12u "$Email"
  Pop $hA1
  ${NSD_CreateCheckBox} 0 32u 100% 10u "自动生成强密码（推荐；安装结束时显示一次）"
  Pop $hA3
  ${NSD_OnClick} $hA3 ToggleAuto
  ${NSD_CreateLabel} 0 48u 100% 10u "管理员密码（至少 16 个字符）："
  Pop $0
  ${NSD_CreatePassword} 0 59u 100% 12u "$AdminPass"
  Pop $hA5
  ${NSD_CreateLabel} 0 76u 100% 10u "再输入一次："
  Pop $0
  ${NSD_CreatePassword} 0 87u 100% 12u "$AdminPass2"
  Pop $hA6
  ${If} $AutoPass == 1
    ${NSD_Check} $hA3
  ${EndIf}
  Call ToggleAuto
  nsDialogs::Show
FunctionEnd
Function LeaveAdmin
  ${NSD_GetText} $hA1 $Email
  ${NSD_GetState} $hA3 $AutoPass
  ${NSD_GetText} $hA5 $AdminPass
  ${NSD_GetText} $hA6 $AdminPass2
  StrLen $R0 $Email
  ${If} $R0 < 5
    MessageBox MB_ICONEXCLAMATION|MB_OK "请填写管理员邮箱。"
    Abort
  ${EndIf}
  ${If} $AutoPass != 1
    StrLen $R0 $AdminPass
    ${If} $R0 < 16
      MessageBox MB_ICONEXCLAMATION|MB_OK "管理员密码至少 16 个字符；也可以勾选“自动生成强密码”。"
      Abort
    ${EndIf}
    ${If} $AdminPass != $AdminPass2
      MessageBox MB_ICONEXCLAMATION|MB_OK "两次输入的密码不一致。"
      Abort
    ${EndIf}
    StrCpy $R1 $AdminPass 6
    StrCpy $R2 $AdminPass 5
    StrCpy $R3 $AdminPass 8
    ${If} $R1 == "change"
    ${OrIf} $R2 == "your-"
    ${OrIf} $R3 == "replace-"
      MessageBox MB_ICONEXCLAMATION|MB_OK "密码不能以 change / your- / replace- 开头（这是示例值）。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------- 第 2 步：组件 ----------
Function ToggleRunner
  ${NSD_GetState} $hA1 $R0
  ${If} $R0 == 1
    EnableWindow $hA2 1
    EnableWindow $hA3 1
    EnableWindow $hA4 1
  ${Else}
    EnableWindow $hA2 0
    EnableWindow $hA3 0
    EnableWindow $hA4 0
  ${EndIf}
FunctionEnd
Function PageComponents
  !insertmacro MUI_HEADER_TEXT "安装组件" "只安装勾选的固定组件，不接受任意命令或软件包。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 0 0 100% 10u "Node.js 22（必装：自动下载官方包并校验 SHA256）"
  Pop $0
  ${NSD_CreateCheckBox} 0 14u 100% 10u "智能体运行器 + 代码沙箱（让智能体在工作区里读写文件、运行代码）"
  Pop $hA1
  ${NSD_OnClick} $hA1 ToggleRunner
  ${NSD_CreateCheckBox} 12u 28u 90% 10u "Claude Code"
  Pop $hA2
  ${NSD_CreateCheckBox} 12u 40u 90% 10u "Codex"
  Pop $hA3
  ${NSD_CreateCheckBox} 12u 52u 90% 10u "Pi"
  Pop $hA4
  ${NSD_CreateCheckBox} 0 70u 100% 10u "使用国内镜像下载 Node.js 和依赖（国内服务器建议勾选）"
  Pop $hA5
  ${NSD_CreateLabel} 0 88u 100% 36u "运行器和沙箱用独立的低权限账号运行，隔离强度弱于 Docker 版。Claude Code 在 Windows 上需要先安装 Git for Windows；没装也能继续，装好后执行 engines 命令即可。"
  Pop $0
  ${If} $WithRunner == 1
    ${NSD_Check} $hA1
  ${EndIf}
  ${If} $EngClaude == 1
    ${NSD_Check} $hA2
  ${EndIf}
  ${If} $EngCodex == 1
    ${NSD_Check} $hA3
  ${EndIf}
  ${If} $EngPi == 1
    ${NSD_Check} $hA4
  ${EndIf}
  ${If} $UseCN == 1
    ${NSD_Check} $hA5
  ${EndIf}
  Call ToggleRunner
  nsDialogs::Show
FunctionEnd
Function LeaveComponents
  ${NSD_GetState} $hA1 $WithRunner
  ${NSD_GetState} $hA2 $EngClaude
  ${NSD_GetState} $hA3 $EngCodex
  ${NSD_GetState} $hA4 $EngPi
  ${NSD_GetState} $hA5 $UseCN
  StrCpy $EnginesList ""
  ${If} $EngClaude == 1
    StrCpy $EnginesList "claude"
  ${EndIf}
  ${If} $EngCodex == 1
    ${If} $EnginesList == ""
      StrCpy $EnginesList "codex"
    ${Else}
      StrCpy $EnginesList "$EnginesList,codex"
    ${EndIf}
  ${EndIf}
  ${If} $EngPi == 1
    ${If} $EnginesList == ""
      StrCpy $EnginesList "pi"
    ${Else}
      StrCpy $EnginesList "$EnginesList,pi"
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------- 第 3 步：服务器与存储 ----------
Function ChangeStorage
  SendMessage $hA5 ${CB_GETCURSEL} 0 0 $R0
  ${If} $R0 == 1
    EnableWindow $hA6 1
  ${Else}
    EnableWindow $hA6 0
  ${EndIf}
FunctionEnd
Function PageServer
  !insertmacro MUI_HEADER_TEXT "服务器与存储" "端口、访问方式和数据存放位置。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 0 0 60u 10u "服务端口："
  Pop $0
  ${NSD_CreateText} 0 11u 50u 12u "$Port"
  Pop $hA1
  ${NSD_CreateLabel} 64u 0 100% 10u "站点域名（可选，选“域名自动证书”时必填）："
  Pop $0
  ${NSD_CreateText} 64u 11u 70% 12u "$Domain"
  Pop $hA2
  ${NSD_CreateLabel} 0 30u 100% 10u "访问方式："
  Pop $0
  ${NSD_CreateDropList} 0 41u 100% 60u ""
  Pop $hA3
  ${NSD_CB_AddString} $hA3 "直接 HTTP（最简单；公网使用建议改用 HTTPS）"
  ${NSD_CB_AddString} $hA3 "HTTPS · 自签名证书（Caddy，端口 8443，浏览器会提示不安全）"
  ${NSD_CB_AddString} $hA3 "HTTPS · 域名自动证书（Caddy，域名需解析到本机，放行 80/443）"
  SendMessage $hA3 ${CB_SETCURSEL} $Access 0
  ${NSD_CreateLabel} 0 60u 100% 10u "数据存储："
  Pop $0
  ${NSD_CreateDropList} 0 71u 100% 40u ""
  Pop $hA5
  ${NSD_CB_AddString} $hA5 "加密 JSON 文件（小团队，无需数据库）"
  ${NSD_CB_AddString} $hA5 "PostgreSQL（外部数据库，安装前会先测试连接）"
  SendMessage $hA5 ${CB_SETCURSEL} $Storage 0
  ${NSD_OnChange} $hA5 ChangeStorage
  ${NSD_CreateLabel} 0 90u 100% 10u "PostgreSQL 连接地址（postgresql://用户:密码@主机:5432/数据库）："
  Pop $0
  ${NSD_CreateText} 0 101u 100% 12u "$PgUrl"
  Pop $hA6
  Call ChangeStorage
  nsDialogs::Show
FunctionEnd
Function LeaveServer
  ${NSD_GetText} $hA1 $Port
  ${NSD_GetText} $hA2 $Domain
  SendMessage $hA3 ${CB_GETCURSEL} 0 0 $Access
  SendMessage $hA5 ${CB_GETCURSEL} 0 0 $Storage
  ${NSD_GetText} $hA6 $PgUrl
  ${If} $Port < 1024
  ${OrIf} $Port > 65535
    MessageBox MB_ICONEXCLAMATION|MB_OK "端口需要在 1024 到 65535 之间。"
    Abort
  ${EndIf}
  ${If} $Access == 2
  ${AndIf} $Domain == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "选择“域名自动证书”需要填写站点域名。"
    Abort
  ${EndIf}
  ${If} $Storage == 1
    StrCpy $R0 $PgUrl 11
    StrCpy $R1 $PgUrl 13
    ${If} $R0 != "postgres://"
    ${AndIf} $R1 != "postgresql://"
      MessageBox MB_ICONEXCLAMATION|MB_OK "PostgreSQL 连接地址要以 postgres:// 或 postgresql:// 开头。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------- 第 4 步：模型与使用方式 ----------
Function ChangePreset
  SendMessage $hA1 ${CB_GETCURSEL} 0 0 $R0
  ${If} $R0 > 0
    Call ApplyPreset
    ${NSD_SetText} $hA2 "$ModelUrl"
  ${EndIf}
FunctionEnd
Function PageModel
  !insertmacro MUI_HEADER_TEXT "模型服务与使用方式" "可以跳过，以后在管理设置里添加；API Key 只写入服务器的秘密文件。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 0 0 100% 10u "模型服务商（选择后自动填入服务地址）："
  Pop $0
  ${NSD_CreateDropList} 0 11u 100% 90u ""
  Pop $hA1
  !insertmacro ADD_PRESETS $hA1
  SendMessage $hA1 ${CB_SETCURSEL} $ModelPreset 0
  ${NSD_OnChange} $hA1 ChangePreset
  ${NSD_CreateLabel} 0 28u 100% 10u "模型服务地址（OpenAI 兼容）："
  Pop $0
  ${NSD_CreateText} 0 39u 100% 12u "$ModelUrl"
  Pop $hA2
  ${NSD_CreateLabel} 0 56u 100% 10u "API Key："
  Pop $0
  ${NSD_CreatePassword} 0 67u 100% 12u "$ModelKey"
  Pop $hA3
  ${NSD_CreateLabel} 0 84u 100% 10u "模型名（例如 gpt-4o-mini、deepseek-chat）："
  Pop $0
  ${NSD_CreateText} 0 95u 100% 12u "$ModelName"
  Pop $hA4
  ${NSD_CreateLabel} 0 113u 50u 10u "使用方式："
  Pop $0
  ${NSD_CreateDropList} 50u 111u 150u 40u ""
  Pop $hA5
  ${NSD_CB_AddString} $hA5 "团队使用（成员、邀请）"
  ${NSD_CB_AddString} $hA5 "个人使用（隐藏团队功能）"
  SendMessage $hA5 ${CB_SETCURSEL} $Usage 0
  nsDialogs::Show
FunctionEnd
Function LeaveModel
  SendMessage $hA1 ${CB_GETCURSEL} 0 0 $ModelPreset
  ${NSD_GetText} $hA2 $ModelUrl
  ${NSD_GetText} $hA3 $ModelKey
  ${NSD_GetText} $hA4 $ModelName
  SendMessage $hA5 ${CB_GETCURSEL} 0 0 $Usage
  ${If} $ModelUrl != ""
    StrCpy $R0 $ModelUrl 7
    StrCpy $R1 $ModelUrl 8
    ${If} $R0 != "http://"
    ${AndIf} $R1 != "https://"
      MessageBox MB_ICONEXCLAMATION|MB_OK "模型服务地址要以 http:// 或 https:// 开头。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------- 第 5 步：其它选项 ----------
Function PageOptions
  !insertmacro MUI_HEADER_TEXT "其它选项" "这些都可以以后在管理页面或命令行里改。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateCheckBox} 0 0 100% 10u "每天凌晨 3:30 自动备份数据（保留 14 份）"
  Pop $hA1
  ${NSD_CreateCheckBox} 0 16u 100% 10u "允许管理员在网页里从 GitHub 一键更新（备份 → 替换 → 起不来自动回滚）"
  Pop $hA2
  ${NSD_CreateCheckBox} 0 32u 100% 10u "在 Windows 防火墙里放行服务端口"
  Pop $hA3
  !ifdef HAS_CLIENTS
    ${NSD_CreateCheckBox} 0 48u 100% 10u "发布安装包里自带的客户端安装包（Windows / Android，网页里的“下载客户端”）"
    Pop $hA4
    ${If} $Clients == 1
      ${NSD_Check} $hA4
    ${EndIf}
  !endif
  ${If} $Backup == 1
    ${NSD_Check} $hA1
  ${EndIf}
  ${If} $WebUpdate == 1
    ${NSD_Check} $hA2
  ${EndIf}
  ${If} $Firewall == 1
    ${NSD_Check} $hA3
  ${EndIf}
  ${NSD_CreateLabel} 0 70u 100% 40u "云服务器还需要在控制台的安全组里放行对应端口。"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function LeaveOptions
  ${NSD_GetState} $hA1 $Backup
  ${NSD_GetState} $hA2 $WebUpdate
  ${NSD_GetState} $hA3 $Firewall
  !ifdef HAS_CLIENTS
    ${NSD_GetState} $hA4 $Clients
  !else
    StrCpy $Clients 0
  !endif
FunctionEnd

; ---------- 第 6 步：Docker 功能 ----------
Function ToggleDocker
  ${NSD_GetState} $hA1 $R0
  ${If} $R0 == 1
    EnableWindow $hA2 1
    ${NSD_GetState} $hA2 $R1
    ${If} $R1 == 1
      EnableWindow $hA3 1
    ${Else}
      EnableWindow $hA3 0
    ${EndIf}
  ${Else}
    EnableWindow $hA2 0
    EnableWindow $hA3 0
  ${EndIf}
FunctionEnd
Function PageDocker
  !insertmacro MUI_HEADER_TEXT "Docker 功能（可选）" "Cindy 桌面端容器、自建语音识别等功能要用 Linux 容器。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateCheckBox} 0 0 100% 10u "安装 Docker 运行环境（WSL2 + 专用 Ubuntu + Docker 引擎）"
  Pop $hA1
  ${NSD_OnClick} $hA1 ToggleDocker
  ${NSD_CreateCheckBox} 12u 14u 95% 10u "同时安装 Cindy 桌面端容器（浏览器里的远程桌面）"
  Pop $hA2
  ${NSD_OnClick} $hA2 ToggleDocker
  ${NSD_CreateDropList} 24u 27u 150u 40u ""
  Pop $hA3
  ${NSD_CB_AddString} $hA3 "国际版 Cindy（Global）"
  ${NSD_CB_AddString} $hA3 "国内版 Cindy（CN，中国大陆账号）"
  ${If} $DeskRegion == 2
    SendMessage $hA3 ${CB_SETCURSEL} 1 0
  ${Else}
    SendMessage $hA3 ${CB_SETCURSEL} 0 0
  ${EndIf}
  ${If} $Docker == 1
    ${NSD_Check} $hA1
  ${EndIf}
  ${If} $DeskRegion > 0
    ${NSD_Check} $hA2
  ${EndIf}
  ${NSD_CreateLabel} 0 46u 100% 80u "要求：Windows Server 2022 或更新（Windows 10 2004 以上也可以）；至少 10 GB 空闲磁盘；需要联网。$\r$\n$\r$\n云服务器要选支持嵌套虚拟化的实例规格，否则 WSL2 起不来（会明确提示原因，其它功能不受影响）。$\r$\n$\r$\n首次启用 WSL2 需要重启服务器：重启后自动继续安装，不用再操作。不使用 Docker Desktop，Docker 引擎装在专用的 Ubuntu 里（Yumeiro-Docker）。以后也可以随时执行 yumeiro-windows.ps1 docker install。"
  Pop $0
  Call ToggleDocker
  nsDialogs::Show
FunctionEnd
Function LeaveDocker
  ${NSD_GetState} $hA1 $Docker
  ${NSD_GetState} $hA2 $R0
  SendMessage $hA3 ${CB_GETCURSEL} 0 0 $R1
  StrCpy $DeskRegion 0
  ${If} $Docker == 1
  ${AndIf} $R0 == 1
    ${If} $R1 == 1
      StrCpy $DeskRegion 2
    ${Else}
      StrCpy $DeskRegion 1
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------- 第 7 步：复核 ----------
Function BuildSummary
  StrCpy $Summary "安装位置：$INSTDIR$\r$\n数据目录：$DataRoot$\r$\n$\r$\n"
  StrCpy $Summary "$Summary管理员：$Email（"
  ${If} $AutoPass == 1
    StrCpy $Summary "$Summary密码自动生成，结束时显示一次）$\r$\n"
  ${Else}
    StrCpy $Summary "$Summary使用你设置的密码）$\r$\n"
  ${EndIf}
  ${If} $Access == 1
    StrCpy $AccessText "HTTPS 自签名证书（端口 8443）"
  ${ElseIf} $Access == 2
    StrCpy $AccessText "HTTPS 域名自动证书（$Domain）"
  ${Else}
    StrCpy $AccessText "直接 HTTP"
  ${EndIf}
  StrCpy $Summary "$Summary服务端口：$Port；访问方式：$AccessText$\r$\n"
  ${If} $Storage == 1
    StrCpy $Summary "$Summary数据存储：PostgreSQL（先测试连接）$\r$\n"
  ${Else}
    StrCpy $Summary "$Summary数据存储：加密 JSON 文件$\r$\n"
  ${EndIf}
  ${If} $WithRunner == 1
    StrCpy $Summary "$Summary智能体运行器 + 代码沙箱：安装；引擎：$EnginesList$\r$\n"
  ${Else}
    StrCpy $Summary "$Summary智能体运行器 + 代码沙箱：不安装$\r$\n"
  ${EndIf}
  ${If} $ModelUrl != ""
    StrCpy $Summary "$Summary模型：$ModelUrl $ModelName$\r$\n"
  ${Else}
    StrCpy $Summary "$Summary模型：稍后在管理设置里添加$\r$\n"
  ${EndIf}
  ${If} $Usage == 1
    StrCpy $Summary "$Summary使用方式：个人$\r$\n"
  ${Else}
    StrCpy $Summary "$Summary使用方式：团队$\r$\n"
  ${EndIf}
  ${If} $Backup == 1
    StrCpy $Summary "$Summary每日自动备份：开$\r$\n"
  ${Else}
    StrCpy $Summary "$Summary每日自动备份：关$\r$\n"
  ${EndIf}
  ${If} $WebUpdate == 1
    StrCpy $Summary "$Summary网页一键更新：开$\r$\n"
  ${Else}
    StrCpy $Summary "$Summary网页一键更新：关$\r$\n"
  ${EndIf}
  ${If} $Firewall == 1
    StrCpy $Summary "$Summary防火墙放行端口：是$\r$\n"
  ${Else}
    StrCpy $Summary "$Summary防火墙放行端口：否$\r$\n"
  ${EndIf}
  ${If} $UseCN == 1
    StrCpy $Summary "$Summary下载源：国内镜像$\r$\n"
  ${EndIf}
  ${If} $Docker == 1
    StrCpy $Summary "$Summary容器环境（Docker）：安装（WSL2 + 专用 Ubuntu；首次启用需要重启）$\r$\n"
    ${If} $DeskRegion == 1
      StrCpy $Summary "$Summary　Cindy 桌面端容器：国际版$\r$\n"
    ${ElseIf} $DeskRegion == 2
      StrCpy $Summary "$Summary　Cindy 桌面端容器：国内版$\r$\n"
    ${EndIf}
  ${Else}
    StrCpy $Summary "$Summary容器环境（Docker）：不安装$\r$\n"
  ${EndIf}
FunctionEnd
Function PageReview
  Call BuildSummary
  !insertmacro MUI_HEADER_TEXT "确认安装设置" "点“安装”开始。安装需要联网，几分钟。"
  nsDialogs::Create 1018
  Pop $Dialog
  nsDialogs::CreateControl EDIT ${__NSD_Text_STYLE}|${ES_MULTILINE}|${ES_READONLY}|${WS_VSCROLL} ${__NSD_Text_EXSTYLE} 0 0 100% 118u "$Summary"
  Pop $0
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:安装"
  nsDialogs::Show
FunctionEnd

; ---------- 安装 ----------
Function WriteAnswers
  ; 答案文件用 UTF-16 写（带 BOM），脚本按 BOM 识别；里面有密码 / 数据库地址 / API Key，脚本读完立刻删除
  CreateDirectory "$INSTDIR\_setup"
  StrCpy $AnswersPath "$INSTDIR\_setup\answers.txt"
  FileOpen $R9 "$AnswersPath" w
  FileWriteWord $R9 "65279"
  FileWriteUTF16LE $R9 "AdminEmail=$Email$\r$\n"
  ${If} $AutoPass != 1
    FileWriteUTF16LE $R9 "AdminPassword=$AdminPass$\r$\n"
  ${EndIf}
  FileWriteUTF16LE $R9 "Port=$Port$\r$\n"
  FileWriteUTF16LE $R9 "Domain=$Domain$\r$\n"
  ${If} $Access == 1
    FileWriteUTF16LE $R9 "Https=self$\r$\n"
  ${ElseIf} $Access == 2
    FileWriteUTF16LE $R9 "Https=domain$\r$\n"
  ${EndIf}
  ${If} $Storage == 1
    FileWriteUTF16LE $R9 "Storage=postgres$\r$\nPgUrl=$PgUrl$\r$\n"
  ${EndIf}
  FileWriteUTF16LE $R9 "ModelUrl=$ModelUrl$\r$\nModelName=$ModelName$\r$\nModelKey=$ModelKey$\r$\n"
  FileWriteUTF16LE $R9 "Runner=$WithRunner$\r$\nEngines=$EnginesList$\r$\nCN=$UseCN$\r$\n"
  ${If} $Usage == 1
    FileWriteUTF16LE $R9 "Personal=1$\r$\n"
  ${EndIf}
  FileWriteUTF16LE $R9 "Backup=$Backup$\r$\nWebUpdate=$WebUpdate$\r$\nFirewall=$Firewall$\r$\nClients=$Clients$\r$\n"
  FileWriteUTF16LE $R9 "NoService=$NoSvc$\r$\n"
  ${If} $Docker == 1
    FileWriteUTF16LE $R9 "Docker=1$\r$\n"
    ${If} $DeskRegion == 1
      FileWriteUTF16LE $R9 "Desktop=global$\r$\n"
    ${ElseIf} $DeskRegion == 2
      FileWriteUTF16LE $R9 "Desktop=cn$\r$\n"
    ${EndIf}
  ${EndIf}
  FileClose $R9
FunctionEnd

Section "Install"
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  Call SetPowerShell
  ; 是否全新安装：失败时只清理全新安装留下的半成品，不动已有数据
  StrCpy $Fresh 1
  ReadRegStr $R0 HKLM "${APP_KEY}" "InstallDir"
  ${If} $R0 != ""
    StrCpy $Fresh 0
  ${EndIf}
  ${If} ${FileExists} "$DataRoot\config\yumeiro.env"
    StrCpy $Fresh 0
  ${EndIf}
  ${If} $ResultPath == ""
    StrCpy $ResultPath "$INSTDIR\_result.txt"
  ${EndIf}
  Call BuildSummary

  SetOutPath "$INSTDIR\_setup\Yumeiro"
  DetailPrint "正在解包安装文件 ..."
  File /r "${STAGE}\*.*"
  Call WriteAnswers

  DetailPrint "正在安装（下载 Node.js、安装依赖、注册系统服务），需要几分钟，请不要关闭 ..."
  nsExec::ExecToLog '"$PS" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\_setup\Yumeiro\deploy\yumeiro-windows.ps1" install -Yes -InstallNode -Prefix "$INSTDIR" -DataRoot "$DataRoot" -AnswersFile "$AnswersPath" -ResultFile "$ResultPath"'
  Pop $0
  ${If} $0 == 3010
    ; 主体已装好，只是 Docker 的 WSL2 刚启用，需要重启才能继续（脚本已登记开机任务，重启后自动接着装）
    StrCpy $NeedReboot 1
    StrCpy $0 0
  ${EndIf}
  ${If} $0 != 0
    ${If} $Fresh == 1
      DetailPrint "安装没有成功，正在清理这次安装留下的文件 ..."
      nsExec::ExecToLog '"$PS" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\_setup\Yumeiro\deploy\yumeiro-windows.ps1" uninstall -Yes -PurgeData -Prefix "$INSTDIR" -DataRoot "$DataRoot"'
      Pop $1
      SetOutPath "$TEMP"
      RMDir /r "$INSTDIR\_setup"
    ${EndIf}
    Delete "$AnswersPath"
    MessageBox MB_ICONSTOP|MB_OK "安装没有成功（退出码 $0）。请查看上方的详细输出：常见原因是服务器连不上网络（可勾选“使用国内镜像”）、端口被占用，或 PostgreSQL 连不上。" /SD IDOK
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\_setup"
  ${If} $NeedReboot == 1
    SetRebootFlag true   ; 结束页会出现“立即重启 / 稍后重启”；重启后 Docker 的安装自动继续
  ${EndIf}

  ; 记下装了什么：卸载向导据此逐项取消（用 UTF-16 写，非中文系统区域的服务器上也不会变成问号）
  FileOpen $R0 "$INSTDIR\components.txt" w
  FileWriteWord $R0 "65279"
  FileWriteUTF16LE $R0 "$Summary"
  FileClose $R0
  FileOpen $R0 "$INSTDIR\dataroot.txt" w
  FileWriteWord $R0 "65279"
  FileWriteUTF16LE $R0 "$DataRoot"
  FileClose $R0
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${APP_KEY}" "DataRoot" "$DataRoot"
  WriteRegStr HKLM "${APP_KEY}" "Port" "$Port"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "Yumeiro"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  ; 开始菜单
  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  WriteINIStr "$SMPROGRAMS\${PRODUCT_NAME}\打开 Yumeiro 管理页面.url" "InternetShortcut" "URL" "http://127.0.0.1:$Port/"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\查看服务状态.lnk" "$PS" '-NoProfile -ExecutionPolicy Bypass -NoExit -File "$INSTDIR\app\deploy\yumeiro-windows.ps1" status -Prefix "$INSTDIR" -DataRoot "$DataRoot"'
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\卸载 Yumeiro.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

; ---------- 安装结果页（显示管理员初始密码，只显示这一次）----------
Function TrimEnd
  ; 去掉 $R8 末尾的回车换行
  StrCpy $R7 $R8 "" -1
  ${If} $R7 == "$\n"
    StrCpy $R8 $R8 -1
  ${EndIf}
  StrCpy $R7 $R8 "" -1
  ${If} $R7 == "$\r"
    StrCpy $R8 $R8 -1
  ${EndIf}
FunctionEnd
Function PageResult
  ${If} ${Silent}
    Abort
  ${EndIf}
  StrCpy $ResUrl ""
  StrCpy $ResEmail $Email
  StrCpy $ResPass ""
  StrCpy $ResNote ""
  StrCpy $ResScheme "http"
  ClearErrors
  FileOpen $R0 "$ResultPath" r
  ${IfNot} ${Errors}
    ${Do}
      FileRead $R0 $R1
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      StrCpy $R2 $R1 12
      ${If} $R2 == "ADMIN_EMAIL="
        StrCpy $R8 $R1 "" 12
        Call TrimEnd
        StrCpy $ResEmail $R8
      ${EndIf}
      StrCpy $R2 $R1 15
      ${If} $R2 == "ADMIN_PASSWORD="
        StrCpy $R8 $R1 "" 15
        Call TrimEnd
        StrCpy $ResPass $R8
      ${EndIf}
      StrCpy $R2 $R1 14
      ${If} $R2 == "PASSWORD_NOTE="
        StrCpy $R8 $R1 "" 14
        Call TrimEnd
        StrCpy $ResNote $R8
      ${EndIf}
      StrCpy $R2 $R1 7
      ${If} $R2 == "DOCKER="
        StrCpy $R8 $R1 "" 7
        Call TrimEnd
        StrCpy $DockerNote $R8
      ${EndIf}
      StrCpy $R2 $R1 7
      ${If} $R2 == "SCHEME="
        StrCpy $R8 $R1 "" 7
        Call TrimEnd
        StrCpy $ResScheme $R8
      ${EndIf}
    ${Loop}
    FileClose $R0
  ${EndIf}
  ${If} $ResScheme == "https"
    ${If} $Domain != ""
    ${AndIf} $Access == 2
      StrCpy $ResUrl "https://$Domain/"
    ${Else}
      StrCpy $ResUrl "https://<服务器IP>:8443/"
    ${EndIf}
  ${Else}
    StrCpy $ResUrl "http://<服务器IP>:$Port/"
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "安装完成" "请记下下面的登录信息。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 0 0 100% 20u "Yumeiro 已安装并启动。浏览器打开下面的地址（云服务器别忘了在安全组里放行对应端口；本机访问可把 <服务器IP> 换成 127.0.0.1）："
  Pop $0
  ${NSD_CreateText} 0 24u 100% 12u "$ResUrl"
  Pop $0
  SendMessage $0 0x00CF 1 0
  ${NSD_CreateLabel} 0 44u 100% 10u "管理员邮箱："
  Pop $0
  ${NSD_CreateText} 0 56u 100% 12u "$ResEmail"
  Pop $0
  SendMessage $0 0x00CF 1 0
  ${If} $ResPass != ""
    ${NSD_CreateLabel} 0 76u 100% 10u "管理员初始密码（只显示这一次，请马上记下；首次登录后请修改）："
    Pop $0
    ${NSD_CreateText} 0 88u 100% 12u "$ResPass"
    Pop $0
    SendMessage $0 0x00CF 1 0
  ${ElseIf} $ResNote == "custom"
    ${NSD_CreateLabel} 0 76u 100% 20u "管理员密码就是你在向导里设置的密码（不会再显示）。"
    Pop $0
  ${Else}
    ${NSD_CreateLabel} 0 76u 100% 20u "这是升级 / 重装：沿用原来的管理员账号和密码。"
    Pop $0
  ${EndIf}
  ${If} $DockerNote == "ok"
    ${NSD_CreateLabel} 0 106u 100% 20u "Docker 运行环境已就绪（专用 WSL2 发行版 Yumeiro-Docker）。"
    Pop $0
  ${ElseIf} $DockerNote == "reboot"
    ${NSD_CreateLabel} 0 106u 100% 28u "Docker：WSL2 刚启用，需要重启服务器。点“完成”后选择重启，重启后会自动继续安装（进度见 日志目录\docker-setup.log）。"
    Pop $0
  ${ElseIf} $DockerNote == "failed"
    ${NSD_CreateLabel} 0 106u 100% 28u "Docker 运行环境没有装成功（其它功能不受影响）：原因见安装日志；修好后执行 yumeiro-windows.ps1 docker install 重试。"
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd
Function LeaveResult
  ; 结果文件里可能有初始密码：显示过就删掉（静默安装且指定了 /RESULT= 时才保留，由调用方负责）
  ${If} $KeepResult == 0
    Delete "$ResultPath"
  ${EndIf}
FunctionEnd

; ---------- 卸载 ----------
Function un.onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  StrCpy $DataRoot "C:\ProgramData\Yumeiro"
  ReadRegStr $R3 HKLM "${APP_KEY}" "DataRoot"
  ${If} $R3 == ""
    ; 注册表里没有（比如不是管理员装的）：读安装目录里记的数据目录
    ClearErrors
    FileOpen $R4 "$INSTDIR\dataroot.txt" r
    ${IfNot} ${Errors}
      FileReadWord $R4 $R5
      FileReadUTF16LE $R4 $R3 1024
      FileClose $R4
    ${EndIf}
    ClearErrors
  ${EndIf}
  ${If} $R3 != ""
    StrCpy $DataRoot $R3
  ${EndIf}
  StrCpy $Purge 0
  ${un.GetParameters} $R0
  ClearErrors
  ${un.GetOptions} $R0 "/PURGE=" $R1
  ${IfNot} ${Errors}
    StrCpy $Purge $R1
  ${EndIf}
  ClearErrors
FunctionEnd

; 卸载向导：列出安装时配置的内容（逐项取消），并问是否同时删除数据
Function un.PageCancel
  ${If} ${Silent}
    Abort
  ${EndIf}
  StrCpy $Summary ""
  ClearErrors
  FileOpen $R0 "$INSTDIR\components.txt" r
  ${IfNot} ${Errors}
    FileReadWord $R0 $R2
    ${Do}
      FileReadUTF16LE $R0 $R1 1024
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      StrCpy $Summary "$Summary$R1"
    ${Loop}
    FileClose $R0
  ${EndIf}
  ${If} $Summary == ""
    StrCpy $Summary "（没有找到安装记录：将按默认清单清理服务、账号和防火墙规则）"
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "取消安装时的设置" "下面这些会被停止并删除："
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 0 0 100% 10u "安装时的设置（卸载会逐项取消，并删除对应的计划任务、专用账号、防火墙规则和程序文件）："
  Pop $0
  nsDialogs::CreateControl EDIT ${__NSD_Text_STYLE}|${ES_MULTILINE}|${ES_READONLY}|${WS_VSCROLL} ${__NSD_Text_EXSTYLE} 0 12u 100% 80u "$Summary"
  Pop $0
  ${NSD_CreateCheckBox} 0 98u 100% 10u "同时删除全部数据（聊天记录、工作区文件、备份、密钥），无法恢复"
  Pop $hPurge
  ${NSD_CreateLabel} 0 112u 100% 20u "不勾选：数据保留在 $DataRoot，以后重新安装可以继续使用（缓存和临时文件仍会清掉）。"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function un.LeaveCancel
  ${NSD_GetState} $hPurge $Purge
FunctionEnd

Section "Uninstall"
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  Call un.SetPowerShell
  StrCpy $R5 'uninstall -Yes -Prefix "$INSTDIR" -DataRoot "$DataRoot"'
  ${If} $Purge == 1
    StrCpy $R5 '$R5 -PurgeData'
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\app\deploy\yumeiro-windows.ps1"
    DetailPrint "正在取消安装时的设置：停止并删除服务、专用账号、防火墙规则和程序 ..."
    nsExec::ExecToLog '"$PS" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\app\deploy\yumeiro-windows.ps1" $R5'
    Pop $0
    ${If} $0 != 0
      ; 脚本没有成功（比如没有管理员权限）：不能继续删程序，否则会留下指向已删除程序的服务
      MessageBox MB_ICONSTOP|MB_OK "卸载没有成功（退出码 $0），为避免留下残缺的服务，没有删除任何文件。请用管理员身份重新运行卸载，详细信息见上方输出。" /SD IDOK
      Abort
    ${EndIf}
  ${Else}
    ; 程序目录已经被删了：用内置命令把系统里登记的东西清掉
    DetailPrint "没有找到安装脚本，直接清理计划任务、防火墙规则和专用账号 ..."
    nsExec::ExecToLog `"$PS" -NoProfile -ExecutionPolicy Bypass -Command "Get-ScheduledTask -TaskName 'Yumeiro*' -ErrorAction SilentlyContinue | ForEach-Object { Stop-ScheduledTask -InputObject $$_ -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $$_ -Confirm:$$false }; Get-NetFirewallRule -DisplayName 'Yumeiro*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; 'yumeiro','yumeiro-runner','yumeiro-sandbox','yumeiro-caddy' | ForEach-Object { Remove-LocalUser -Name $$_ -ErrorAction SilentlyContinue }"`
    Pop $0
    ${If} $Purge == 1
      RMDir /r "$DataRoot"
    ${EndIf}
  ${EndIf}

  SetShellVarContext all
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "${APP_KEY}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
  ${If} ${FileExists} "$INSTDIR"
    DetailPrint "有少量文件仍被占用，重启后可手动删除：$INSTDIR"
  ${EndIf}
  ${If} $Purge != 1
    DetailPrint "数据已保留在 $DataRoot"
  ${EndIf}
SectionEnd
