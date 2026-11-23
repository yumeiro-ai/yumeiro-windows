import SwiftUI

struct AgentsView: View {
    @EnvironmentObject var model: AppModel
    @State private var editing: AgentOpt?
    @State private var creating = false
    @State private var viewing: AgentOpt?

    var body: some View {
        List {
            Section(footer: Text("智能体 = 自己的提示词 + 技能 + 指定模型。选好后，新对话就会使用它。")) {
                if model.agents.isEmpty { Text("还没有智能体。点右上角“新建”，或去“技能市场”安装。").foregroundStyle(.secondary) }
                ForEach(model.agents) { a in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Button { viewing = a } label: { Text(a.name).font(.headline).foregroundStyle(accent) }.buttonStyle(.plain)
                            Spacer()
                            if model.selectedAgent == a.id { Text("使用中").font(.caption).foregroundStyle(accent) } else if a.shared { Text("共享").font(.caption).foregroundStyle(.secondary) }
                        }
                        if !a.description.isEmpty { Text(a.description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        HStack {
                            Button(model.selectedAgent == a.id ? "取消使用" : "用于新对话") { model.selectedAgent = model.selectedAgent == a.id ? "" : a.id }
                            if a.mine || model.isAdmin { Button("编辑") { editing = a } }
                        }.buttonStyle(.borderless).font(.footnote)
                    }
                }
            }
        }
        .navigationTitle("智能体")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("新建") { creating = true } } }
        .task { await model.loadSkills(); await model.loadAgents() }
        .sheet(isPresented: $creating) { AgentEditor(agent: nil) }
        .sheet(item: $editing) { AgentEditor(agent: $0) }
        .sheet(item: $viewing) { a in
            InfoSheet(title: a.name, sub: a.shared ? "共享智能体" : "", description: a.description,
                      content: a.systemPrompt.isEmpty ? ((a.mine || model.isAdmin) ? "（还没有写提示词）" : "（提示词仅创建者和管理员可见）") : a.systemPrompt,
                      onEdit: (a.mine || model.isAdmin) ? { editing = a } : nil)
        }
    }
}

struct AgentEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let agent: AgentOpt?
    @State private var name = ""; @State private var desc = ""; @State private var prompt = ""; @State private var modelRef = ""
    @State private var shared = false; @State private var picked: Set<String> = []; @State private var err = ""
    @State private var showModels = false; @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("名称", text: $name)
                TextField("一句话说明（可选）", text: $desc)
                Section("系统提示词（它的身份、说话方式、规则）") { TextEditor(text: $prompt).frame(minHeight: 120) }
                Button { showModels = true } label: { HStack { Text("模型"); Spacer(); Text(model.models.first { $0.ref == modelRef }?.label ?? "跟随默认").foregroundStyle(.secondary) } }.buttonStyle(.plain)
                if !model.skills.isEmpty {
                    Section("绑定技能（最多 8 个）") {
                        ForEach(model.skills) { s in
                            Button { if picked.contains(s.id) { picked.remove(s.id) } else { picked.insert(s.id) } } label: {
                                HStack { Text(s.title); Spacer(); if picked.contains(s.id) { Image(systemName: "checkmark").foregroundStyle(accent) } }.contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if model.isAdmin { Toggle("共享给所有成员", isOn: $shared) }
                if !err.isEmpty { Text(err).foregroundColor(.red).font(.footnote) }
                if agent != nil { Button("删除智能体", role: .destructive) { confirmDelete = true } }
            }
            .formStyle(.grouped)
            .navigationTitle(agent == nil ? "新建智能体" : "编辑智能体")
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { if let e = await model.saveAgent(id: agent?.id, name: name.trimmingCharacters(in: .whitespaces), description: desc, prompt: prompt, model: modelRef, skillIds: Array(picked), shared: shared) { err = e } else { dismiss() } } } }
            }
            .sheet(isPresented: $showModels) {
                PickerSheet(title: "模型", options: [Opt(id: "", label: "跟随默认")] + model.models.map { Opt(id: $0.ref, label: $0.label, sub: $0.provider) }, selected: modelRef) { modelRef = $0 }
            }
            .confirmationDialog("删除这个智能体？", isPresented: $confirmDelete, titleVisibility: .visible) { Button("删除", role: .destructive) { if let id = agent?.id { Task { await model.deleteAgent(id); dismiss() } } } }
        }
        .frame(minWidth: 420, minHeight: 520)
        .onAppear {
            if let a = agent { name = a.name; desc = a.description; prompt = a.systemPrompt; modelRef = a.model; shared = a.shared; picked = Set(a.skillIds) }
        }
    }
}

struct SkillsView: View {
    @EnvironmentObject var model: AppModel
    @State private var editing: SkillItem?
    @State private var creating = false
    @State private var viewing: SkillItem?

    var body: some View {
        List {
            Section(footer: Text("技能是一段写好的说明，绑定到智能体后，它会照着做。")) {
                if model.skills.isEmpty { Text("还没有技能。可以新建，或去“技能市场”一键安装。").foregroundStyle(.secondary) }
                ForEach(model.skills) { s in
                    Button { viewing = s } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack { Text(s.title).font(.headline).foregroundStyle(accent); Spacer(); if s.shared { Text("共享").font(.caption).foregroundStyle(.secondary) } }
                            if !s.description.isEmpty { Text(s.description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }
        }
        .navigationTitle("技能")
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button("新建") { creating = true } }
            ToolbarItem(placement: .navigation) { NavigationLink(value: Page.market) { Text("市场") } }
        }
        .task { await model.loadSkills() }
        .sheet(isPresented: $creating) { SkillEditor(skill: nil) }
        .sheet(item: $editing) { SkillEditor(skill: $0) }
        .sheet(item: $viewing) { s in InfoSheet(title: s.title, sub: s.shared ? "共享技能" : "", description: s.description, content: s.content, onEdit: (s.mine || model.isAdmin) ? { editing = s } : nil) }
    }
}

struct SkillEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let skill: SkillItem?
    @State private var title = ""; @State private var desc = ""; @State private var content = ""; @State private var shared = false; @State private var err = ""; @State private var confirmDelete = false
    var body: some View {
        NavigationStack {
            Form {
                TextField("名称", text: $title)
                TextField("一句话说明（可选）", text: $desc)
                Section("技能内容（写清楚什么时候用、怎么做）") { TextEditor(text: $content).frame(minHeight: 200) }
                if model.isAdmin { Toggle("共享给所有成员", isOn: $shared) }
                if !err.isEmpty { Text(err).foregroundColor(.red).font(.footnote) }
                if skill != nil { Button("删除技能", role: .destructive) { confirmDelete = true } }
            }
            .formStyle(.grouped)
            .navigationTitle(skill == nil ? "新建技能" : "编辑技能")
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { if let e = await model.saveSkill(id: skill?.id, title: title.trimmingCharacters(in: .whitespaces), description: desc, content: content, shared: shared) { err = e } else { dismiss() } } } }
            }
            .confirmationDialog("删除这个技能？已绑定它的智能体会自动解除。", isPresented: $confirmDelete, titleVisibility: .visible) { Button("删除", role: .destructive) { if let id = skill?.id { Task { await model.deleteSkill(id); dismiss() } } } }
        }
        .frame(minWidth: 420, minHeight: 480)
        .onAppear { if let s = skill { title = s.title; desc = s.description; content = s.content; shared = s.shared } }
    }
}

struct MarketView: View {
    @EnvironmentObject var model: AppModel
    @State private var previewItem: MarketItem?
    @State private var previewText = ""

    var body: some View {
        List {
            Section(footer: Text("装好的技能会出现在“技能”里，机器人类会变成一个智能体。")) {
                if model.market.isEmpty { Text("市场里暂时没有内容（或正在加载）。").foregroundStyle(.secondary) }
                ForEach(model.market) { m in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Button { open(m) } label: { Text(m.title).font(.headline).foregroundStyle(accent) }.buttonStyle(.plain)
                            Spacer(); Text(m.type == "bot" ? "智能体" : "技能").font(.caption2).foregroundStyle(.secondary)
                        }
                        Text(m.author).font(.caption2).foregroundStyle(.secondary)
                        if !m.description.isEmpty { Text(m.description).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                        HStack {
                            Button("预览") { open(m) }
                            if m.installed { Text("已安装").foregroundStyle(.secondary) } else { Button("安装") { Task { await model.installMarket(m) } }.buttonStyle(.borderedProminent) }
                        }.buttonStyle(.borderless).font(.footnote)
                    }
                }
            }
        }
        .navigationTitle("技能市场")
        .task { await model.loadMarket() }
        .sheet(item: $previewItem) { m in InfoSheet(title: m.title, sub: m.author, description: m.description, content: previewText) }
    }
    private func open(_ m: MarketItem) { previewText = "正在读取…"; previewItem = m; Task { previewText = await model.marketPreview(m) } }
}

struct AdminView: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = 0
    @State private var adding = false
    @State private var resetting: Member?
    @State private var deleting: Member?

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) { Text("成员").tag(0); Text("用量").tag(1); Text("MCP").tag(2); Text("安全与熔断").tag(3); Text("套餐与授权").tag(4); Text("模型价格").tag(5); Text("站点设置").tag(6) }.pickerStyle(.menu).padding(.horizontal)
            if !model.isAdmin { Text("只有管理员能用这里。").foregroundStyle(.secondary).padding() }
            else if tab >= 3 { AdminExtraView(tab: tab) }
            else {
                List {
                    switch tab {
                    case 0:
                        Button("＋ 添加成员") { adding = true }
                        ForEach(model.members) { m in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    VStack(alignment: .leading) { Text(m.name).font(.headline).foregroundStyle(m.disabled ? Color.secondary : Color.primary); Text(m.email + (m.disabled ? " · 已停用" : "")).font(.caption).foregroundStyle(.secondary) }
                                    Spacer()
                                    if m.email != model.me.str("email") { Toggle("", isOn: Binding(get: { !m.disabled }, set: { v in Task { await model.setMemberDisabled(m.id, !v) } })).labelsHidden() }
                                }
                                Text("今日 \(m.todayCalls) 次 · 本月 \(m.monthCalls) 次 · \(m.tokens) tokens").font(.caption).foregroundStyle(.secondary)
                                if m.email != model.me.str("email") { HStack { Button("重置密码") { resetting = m }; Button("删除", role: .destructive) { deleting = m } }.buttonStyle(.borderless).font(.footnote) }
                            }
                        }
                    case 1:
                        Text("\(model.usageMonth) 全员用量").font(.caption).foregroundStyle(.secondary)
                        ForEach(model.usageRows) { r in
                            VStack(alignment: .leading) { HStack { Text(r.name).font(.headline); Spacer(); Text("\(r.monthCalls) 次") }; Text("今日 \(r.todayCalls) 次 · \(r.tokens) tokens").font(.caption).foregroundStyle(.secondary) }
                        }
                    default:
                        Text("这里只能开关已有的 MCP 服务；添加、编辑和市场安装请在网页版管理页操作。").font(.caption).foregroundStyle(.secondary)
                        if model.mcp.isEmpty { Text("还没有配置 MCP 服务。").foregroundStyle(.secondary) }
                        ForEach(model.mcp) { m in
                            HStack { VStack(alignment: .leading) { Text(m.name).font(.headline); Text(m.command).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
                                Spacer(); Toggle("", isOn: Binding(get: { m.enabled }, set: { v in Task { await model.toggleMcp(m.name, v) } })).labelsHidden() }
                        }
                    }
                }
            }
        }
        .navigationTitle("管理")
        .task(id: tab) { if model.isAdmin { switch tab { case 0: await model.loadMembers(); case 1: await model.loadUsageAll(); case 2: await model.loadMcp(); default: break } } }
        .sheet(isPresented: $adding) { MemberSheet(member: nil) }
        .sheet(item: $resetting) { MemberSheet(member: $0) }
        .confirmationDialog("删除成员", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { m in
            Button("删除 \(m.email)", role: .destructive) { Task { await model.deleteMember(m.id) } }
        } message: { _ in Text("他的对话、附件等数据都会一起删除，无法恢复。") }
    }
}

/// member 为空 = 添加成员；不为空 = 重置该成员密码
struct MemberSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let member: Member?
    @State private var email = ""; @State private var name = ""; @State private var pw = ""; @State private var err = ""
    var body: some View {
        NavigationStack {
            Form {
                if member == nil { TextField("邮箱", text: $email); TextField("显示名（可选）", text: $name) }
                SecureField(member == nil ? "初始密码（至少 12 位）" : "新密码（至少 12 位）", text: $pw)
                if !err.isEmpty { Text(err).foregroundColor(.red).font(.footnote) }
            }
            .formStyle(.grouped).navigationTitle(member == nil ? "添加成员" : "重置 \(member!.name) 的密码")
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(member == nil ? "创建" : "重置") {
                    Task {
                        var failure: String?
                        if let target = member { failure = await model.resetMemberPassword(target.id, pw) }
                        else { failure = await model.createMember(email: email.trimmingCharacters(in: .whitespaces), name: name, password: pw) }
                        if let e = failure { err = e } else { dismiss() }
                    }
                } }
            }
        }.frame(minWidth: 380, minHeight: 280)
    }
}

/// 管理员在网页登录页点“忘记密码 → 手机确认”后，网页会显示 6 位验证码；在这里批准或拒绝
struct SecurityView: View {
    @EnvironmentObject var model: AppModel
    @State private var code = ""
    @State private var err = ""
    @State private var now = Date()
    @State private var confirm: (code: String, approve: Bool)? = nil

    private var codeReady: Bool { code.filter { $0.isNumber }.count == 6 }

    var body: some View {
        List {
            if !model.isAdmin { Text("只有管理员能用这里。").foregroundStyle(.secondary) }
            else {
                Section {
                    if model.approvals.isEmpty { Text("现在没有待确认的请求。网页上发起后，这里会自动出现；也可以在下面手动输入验证码。").font(.callout).foregroundStyle(.secondary) }
                    ForEach(model.approvals) { a in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(a.code.prefix(3)) + " " + String(a.code.dropFirst(3))).font(.system(size: 28, weight: .bold, design: .monospaced)).foregroundStyle(accent)
                            let left = max(0, Int((a.expiresAt - now.timeIntervalSince1970 * 1000) / 1000))
                            Text("来自 \(a.ip.isEmpty ? "未知地址" : a.ip) · 还剩 \(left / 60):\(String(format: "%02d", left % 60))").font(.caption).foregroundStyle(.secondary)
                            if !a.ua.isEmpty { Text(a.ua).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
                            HStack {
                                Button("批准") { confirm = (a.code, true) }.buttonStyle(.borderedProminent)
                                Button("拒绝", role: .destructive) { confirm = (a.code, false) }.buttonStyle(.bordered)
                            }
                        }
                    }
                } header: { Text("正在等待确认的请求") } footer: { Text("只有确定是你自己在网页上发起的，才批准；批准后，网页上的人可以直接登录你的管理员账号并改密码。") }
                Section("手动输入验证码") {
                    TextField("网页上显示的 6 位验证码", text: $code).iosOnly { $0.keyboardType(.numberPad) }
                    if !err.isEmpty { Text(err).foregroundColor(.red).font(.footnote) }
                    HStack {
                        Button("批准") { confirm = (code, true) }.buttonStyle(.borderedProminent).disabled(!codeReady)
                        Button("拒绝", role: .destructive) { confirm = (code, false) }.buttonStyle(.bordered).disabled(!codeReady)
                    }
                }
            }
        }
        .navigationTitle("网页找回密码确认")
        .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
        .task {
            // 每 3 秒刷新一次待确认的请求，倒计时每秒走一格
            while !Task.isCancelled {
                await model.loadApprovals()
                for _ in 0..<3 { try? await Task.sleep(nanoseconds: 1_000_000_000); now = Date() }
            }
        }
        .confirmationDialog(confirm?.approve == true ? "批准这次请求？" : "拒绝这次请求？", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            Button(confirm?.approve == true ? "批准" : "拒绝", role: confirm?.approve == true ? nil : .destructive) {
                if let c = confirm { Task { err = await model.decideApproval(code: c.code, approve: c.approve) ?? ""; if err.isEmpty { code = "" } } }
            }
            Button("取消", role: .cancel) { }
        } message: { Text(confirm?.approve == true ? "批准后，网页上的人可以直接登录你的管理员账号并改密码。" : "拒绝后，网页那边会提示被拒绝。") }
    }
}
