import SwiftUI
import UniformTypeIdentifiers

/// 选项弹窗：点一项就选中并关闭。长列表（模型、智能体、壁纸…）都用它。
struct PickerSheet: View {
    @Environment(\.dismiss) var dismiss
    let title: String; let options: [Opt]; let selected: String; let onPick: (String) -> Void
    var body: some View {
        NavigationStack {
            List(options) { o in
                Button { onPick(o.id); dismiss() } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) { Text(o.label); if !o.sub.isEmpty { Text(o.sub).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                        Spacer()
                        if o.id == selected { Image(systemName: "checkmark").foregroundStyle(accent) }
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            .navigationTitle(title)
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
        .frame(minWidth: 340, minHeight: 360)
    }
}

private func mostlyChinese(_ text: String) -> Bool {
    let letters = text.filter { $0.isLetter }
    if letters.isEmpty { return true }
    let han = letters.filter { $0.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } }.count
    return Double(han) / Double(letters.count) >= 0.3
}

/// 说明弹窗：名称、简介、内容；英文内容可以一键翻译成中文（用服务器上的模型翻译）。
struct InfoSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let title: String; var sub = ""; let description: String; let content: String; var onEdit: (() -> Void)? = nil
    @State private var zh: (String, String)? = nil
    @State private var showZh = false
    @State private var busy = false
    @State private var err = ""
    var needs: Bool { !mostlyChinese(description) || !mostlyChinese(content) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(.secondary) }
                    let d = showZh ? (zh?.0 ?? description) : description
                    let c = showZh ? (zh?.1 ?? content) : content
                    if !d.isEmpty { Text(d).font(.body) }
                    if !c.isEmpty { Text(c).font(.callout).textSelection(.enabled) } else if d.isEmpty { Text("（没有内容）").foregroundStyle(.secondary) }
                    if showZh { Text("由 AI 翻译，仅供参考。").font(.caption2).foregroundStyle(.secondary) }
                    if !err.isEmpty { Text(err).font(.caption).foregroundColor(.red) }
                }.padding().frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(title)
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .cancellationAction) {
                    HStack {
                        if needs { Button(busy ? "翻译中…" : showZh ? "显示原文" : "翻译成中文") { Task { await toggle() } }.disabled(busy) }
                        if let onEdit = onEdit { Button("编辑") { dismiss(); onEdit() } }
                    }
                }
            }
        }
        .frame(minWidth: 380, minHeight: 420)
    }
    func toggle() async {
        if showZh { showZh = false; return }
        if zh != nil { showZh = true; return }
        busy = true; err = ""; defer { busy = false }
        do {
            var d = description
            if !description.isEmpty && !mostlyChinese(description) { d = try await model.translate(description) }
            var c = content
            if !content.isEmpty && !mostlyChinese(content) { c = try await model.translate(content) }
            zh = (d, c); showZh = true
        } catch { err = "翻译失败：" + ((error as? ApiError)?.message ?? error.localizedDescription) }
    }
}

struct SettingsRoot: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    var body: some View {
        NavigationStack {
            SettingsView()
                .navigationTitle("设置")
                .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .navigationDestination(for: Page.self) { page in
                    switch page {
                    case .agents: AgentsView()
                    case .skills: SkillsView()
                    case .market: MarketView()
                    case .admin: AdminView()
                    case .security: SecurityView()
                    case .workspace: WorkspaceView()
                    case .settings: EmptyView()
                    }
                }
        }
        .frame(minWidth: 460, minHeight: 560)
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var picker = ""
    @State private var addMemory = false
    @State private var memoryDraft = ""
    @State private var clearAsk = false
    @State private var pwd = false

    @State private var pickingWallpaper = false
    // 壁纸只保存在这台设备上：无 / 本机图片 / 内置渐变 / 服务器壁纸库里的某一张（只记名字，服务器改默认壁纸不会影响你）
    private var wallOptions: [Opt] {
        [Opt(id: "", label: "无壁纸"), Opt(id: "pick-local", label: "从本机选一张图片…", sub: "只在这台设备上生效")] +
        (model.wallpaper == "local" ? [Opt(id: "local", label: "我的图片", sub: "本机")] : []) +
        wallPresets.map { Opt(id: "preset:" + $0.id, label: $0.label, sub: "渐变") } +
        model.wallItems.filter { $0.kind == "image" }.map { Opt(id: "server:" + $0.name, label: ($0.name as NSString).deletingPathExtension, sub: "服务器壁纸库") }
    }
    private let dims = [Opt(id: "0", label: "最亮 0%"), Opt(id: "20", label: "20%"), Opt(id: "35", label: "标准 35%"), Opt(id: "50", label: "50%"), Opt(id: "65", label: "65%"), Opt(id: "80", label: "最暗 80%")]
    private let fonts = [Opt(id: "0.9", label: "小"), Opt(id: "1.0", label: "标准"), Opt(id: "1.15", label: "大"), Opt(id: "1.3", label: "特大")]
    private let themes = [Opt(id: "system", label: "跟随系统"), Opt(id: "dark", label: "深色"), Opt(id: "light", label: "浅色")]

    private func row(_ label: String, _ value: String, _ key: String) -> some View {
        Button { picker = key } label: { HStack { Text(label); Spacer(); Text(value).foregroundStyle(.secondary).lineLimit(1); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }.contentShape(Rectangle()) }.buttonStyle(.plain)
    }

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.me.str("displayName").isEmpty ? model.me.str("email") : model.me.str("displayName")).font(.headline)
                    Text(model.me.str("email") + (model.isAdmin ? " · 管理员" : "")).font(.subheadline).foregroundStyle(.secondary)
                    Text(model.session.server).font(.caption).foregroundStyle(.secondary)
                    if !model.usage.isEmpty { Text("用量：" + model.usage).font(.caption).foregroundStyle(.secondary) }
                }
                Button("修改密码") { pwd = true }
            }
            Section("对话") {
                row("默认模型", model.models.first { $0.ref == model.selectedModel }?.label ?? "未选择", "model")
                row("新对话用的智能体", model.agents.first { $0.id == model.selectedAgent }?.name ?? "不使用", "agent")
            }
            Section("更多") {
                NavigationLink(value: Page.agents) { VStack(alignment: .leading) { Text("智能体"); Text("新建、编辑、选择").font(.caption).foregroundStyle(.secondary) } }
                NavigationLink(value: Page.skills) { VStack(alignment: .leading) { Text("技能"); Text("自己写，或从市场安装").font(.caption).foregroundStyle(.secondary) } }
                NavigationLink(value: Page.market) { VStack(alignment: .leading) { Text("技能市场"); Text("浏览并一键安装").font(.caption).foregroundStyle(.secondary) } }
                NavigationLink(value: Page.workspace) { VStack(alignment: .leading) { Text("工作区"); Text("查看工作区和协作成员").font(.caption).foregroundStyle(.secondary) } }
                if model.isAdmin { NavigationLink(value: Page.security) { VStack(alignment: .leading) { Text("网页找回密码确认"); Text("输入网页上的验证码，批准或拒绝").font(.caption).foregroundStyle(.secondary) } } }
                if model.isAdmin { NavigationLink(value: Page.admin) { VStack(alignment: .leading) { Text("管理"); Text("成员、用量、MCP 开关").font(.caption).foregroundStyle(.secondary) } } }
            }
            Section(header: Text("记忆"), footer: Text("它会记住你的偏好和重要信息，让回答更贴合你。不会保存密码和密钥。")) {
                Toggle("启用记忆", isOn: Binding(get: { model.memEnabled }, set: { v in Task { await model.setMemPref("enabled", v) } }))
                Toggle("自动记住", isOn: Binding(get: { model.memAuto }, set: { v in Task { await model.setMemPref("auto", v) } }))
                Toggle("跨对话使用", isOn: Binding(get: { model.memCross }, set: { v in Task { await model.setMemPref("crossChat", v) } }))
                Text("已记住 \(model.memories.count) 条").font(.caption).foregroundStyle(.secondary)
                ForEach(model.memories) { m in Text((m.pinned ? "📌 " : "") + m.text).font(.callout) }
                    .onDelete { idx in for i in idx { let id = model.memories[i].id; Task { await model.deleteMemory(id) } } }
                Button("添加一条") { memoryDraft = ""; addMemory = true }
                if !model.memories.isEmpty { Button("清空", role: .destructive) { clearAsk = true } }
            }
            Section("外观（只影响这台设备的显示方式）") {
                row("主题", themes.first { $0.id == model.themeMode }?.label ?? "深色", "theme")
                row("壁纸", model.wallpaperLabel, "wp")
                row("壁纸遮罩", dims.first { $0.id == String(model.wallDim) }?.label ?? "\(model.wallDim)%", "dim")
                row("字体大小", fonts.first { $0.id == String(model.fontScale) }?.label ?? "标准", "font")
            }
            Section("关于") {
                Text("Yumeiro 苹果原生客户端 0.46.1").font(.footnote).foregroundStyle(.secondary)
                Text("Powered by Yumeiro").font(.caption.bold())
                Text("使用 Cindy、Dash黄一孟 的项目进行制作 · 制作者：BYL").font(.caption2).foregroundStyle(.secondary)
                Text("以 Apache License 2.0 开源；使用、修改、分发请保留署名与许可证").font(.caption2).foregroundStyle(.secondary)
                Text("管理员可以在“管理”里改成员、安全与熔断、套餐、模型价格和站点设置；模型服务商、MCP 添加编辑等更细的设置请在浏览器里打开 服务器地址/admin。").font(.caption).foregroundStyle(.secondary)
            }
            Section { Button("退出登录 / 切换账号", role: .destructive) { Task { await model.logout() } } }
        }
        .formStyle(.grouped)
        .sheet(isPresented: Binding(get: { !picker.isEmpty }, set: { if !$0 { picker = "" } })) {
            switch picker {
            case "model": PickerSheet(title: "默认对话模型", options: model.models.map { Opt(id: $0.ref, label: $0.label, sub: $0.provider) }, selected: model.selectedModel) { model.chooseModel($0) }
            case "agent": PickerSheet(title: "新对话使用的智能体", options: [Opt(id: "", label: "不使用智能体", sub: "普通对话")] + model.agents.map { Opt(id: $0.id, label: $0.name, sub: $0.description) }, selected: model.selectedAgent) { model.selectedAgent = $0 }
            case "theme": PickerSheet(title: "主题", options: themes, selected: model.themeMode) { model.setTheme($0) }
            case "wp": PickerSheet(title: "壁纸（只在这台设备上生效）", options: wallOptions, selected: model.wallpaper) { v in
                if v == "pick-local" { pickingWallpaper = true } else { Task { await model.chooseWallpaper(v) } }
            }
            case "dim": PickerSheet(title: "壁纸遮罩（越大越暗）", options: dims, selected: String(model.wallDim)) { v in Task { await model.chooseWallDim(Int(v) ?? 35) } }
            default: PickerSheet(title: "字体大小", options: fonts, selected: String(model.fontScale)) { model.setFont(Double($0) ?? 1) }
            }
        }
        .fileImporter(isPresented: $pickingWallpaper, allowedContentTypes: [.image], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { model.say("读取图片失败"); return }
            Task { if let err = await model.setLocalWallpaper(data) { model.say(err) } else { model.say("已设为壁纸（只在这台设备上生效）") } }
        }
        .alert("添加记忆", isPresented: $addMemory) {
            TextField("例如：我是前端工程师，偏好简洁回答", text: $memoryDraft)
            Button("保存") { let t = memoryDraft; Task { await model.addMemory(t) } }
            Button("取消", role: .cancel) { }
        }
        .confirmationDialog("清空所有记忆？清空后无法恢复。", isPresented: $clearAsk, titleVisibility: .visible) { Button("清空", role: .destructive) { Task { await model.clearMemories() } } }
        .sheet(isPresented: $pwd) { PasswordSheet() }
    }
}

struct PasswordSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State private var old = ""; @State private var new = ""; @State private var err = ""
    var body: some View {
        NavigationStack {
            Form {
                SecureField("当前密码", text: $old)
                SecureField("新密码（至少 16 位）", text: $new)
                if !err.isEmpty { Text(err).foregroundColor(.red).font(.footnote) }
            }
            .formStyle(.grouped).navigationTitle("修改密码")
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("修改") { Task { if let e = await model.changePassword(old: old, new: new) { err = e } else { dismiss() } } } }
            }
        }.frame(minWidth: 360, minHeight: 260)
    }
}
