import SwiftUI

// 多智能体群聊：产品经理带队（默认）/ @ 点名 / 圆桌 / 接力 / 主管调度。

struct GroupMember: Identifiable, Hashable {
    let id = UUID()
    var label = ""; var model = ""; var role = ""; var strengths = ""
}
struct GroupInfo: Identifiable, Hashable {
    let id: String; var title: String; var mode: String; var rounds: Int
    var pmLabel: String; var pmModel: String; var members: [GroupMember]; var count: Int
}
struct GMsg: Identifiable { let id: Int; var role: String; var label: String; var content: String; var task = ""; var error = false; var streaming = false }

let groupModes: [(id: String, label: String)] = [
    ("pm", "产品经理带队（推荐）"), ("chat", "群聊（@ 点名）"), ("roundtable", "圆桌讨论"), ("pipeline", "接力"), ("supervisor", "主管调度")
]
func groupModeLabel(_ mode: String) -> String { groupModes.first { $0.id == mode }?.label ?? mode }

// 模型名 → (默认身份, 默认擅长)：只是按名字给的建议，用户可以改
private let hintTable: [(String, String, String)] = [
    ("claude|opus|sonnet|haiku", "资深架构师与写作者", "长文写作、代码、严谨推理"),
    ("gpt|o1|o3|o4", "全能工程师", "通用问答、代码、工具调用"),
    ("deepseek", "算法与后端工程师", "代码、数学与推理、性价比高"),
    ("qwen|通义", "中文内容专家", "中文理解、多语言、代码"),
    ("gemini", "资料研究员", "超长上下文、多模态、检索总结"),
    ("glm|智谱", "办公文案助理", "中文对话、办公写作"),
    ("kimi|moonshot", "阅读与总结专员", "长文阅读与总结"),
    ("doubao|豆包", "创意文案", "中文创作、日常对话")
]
func groupHint(_ name: String) -> (role: String, strengths: String) {
    for (pattern, role, strengths) in hintTable where name.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil { return (role, strengths) }
    return ("全能助手", "通用对话与分析")
}
func groupSafeName(_ text: String) -> String {
    let cleaned = String(text.filter { !$0.isWhitespace && $0 != "@" && $0 != "/" }.prefix(20))
    return cleaned.isEmpty ? "模型" : cleaned
}

@MainActor
final class GroupModel: ObservableObject {
    unowned let app: AppModel
    @Published var groups: [GroupInfo] = []
    @Published var current: GroupInfo? = nil
    @Published var messages: [GMsg] = []
    @Published var busy = false
    private var keySeq = 0
    private var task: Task<Void, Never>?

    init(app: AppModel) { self.app = app }

    private func parse(_ g: JSON) -> GroupInfo {
        let pm = g.obj("pm")
        let members = g.list("members").map { GroupMember(label: $0.str("label"), model: $0.str("model"), role: $0.str("role"), strengths: $0.str("strengths")) }
        return GroupInfo(id: g.str("id"), title: g.str("title").isEmpty ? "新群聊" : g.str("title"), mode: g.str("mode").isEmpty ? "chat" : g.str("mode"), rounds: g.int("rounds") == 0 ? 2 : g.int("rounds"),
                         pmLabel: (pm?.str("label")).flatMap { $0.isEmpty ? nil : $0 } ?? "产品经理", pmModel: pm?.str("model") ?? "", members: members, count: g.int("count"))
    }

    func load() async {
        if let d = await app.guarded(quiet: true, { try await app.api.call("GET", "/api/groups") }) { groups = d.list("groups").map(parse) }
    }

    func open(_ id: String) async {
        guard let d = await app.guarded({ try await app.api.call("GET", "/api/groups/\(id)") }) else { return }
        current = d.obj("group").map(parse)
        messages = d.list("messages").map { m in
            keySeq += 1
            return GMsg(id: keySeq, role: m.str("role"), label: m.str("role") == "user" ? "你" : m.str("label"), content: m.str("content"))
        }
    }

    func delete(_ id: String) async {
        _ = await app.guarded { try await app.api.call("DELETE", "/api/groups/\(id)") }
        if current?.id == id { current = nil }
        await load()
    }

    /// 用“我能用的所有模型”生成成员（最多 12 个），身份和擅长按模型名给默认值
    func allModelMembers(existing: [GroupMember] = []) -> [GroupMember] {
        var used = Set(existing.map { $0.model }), names = Set(existing.map { $0.label }), out: [GroupMember] = []
        for m in app.models {
            if existing.count + out.count >= 12 { break }
            if used.contains(m.ref) { continue }
            var name = groupSafeName(m.label), n = 2
            while names.contains(name) { name = groupSafeName(m.label) + String(n); n += 1 }
            names.insert(name); used.insert(m.ref)
            let h = groupHint(m.ref + " " + m.label)
            out.append(GroupMember(label: name, model: m.ref, role: h.role, strengths: h.strengths))
        }
        return out
    }

    /// 返回错误文字；成功返回 nil
    func save(id: String?, title: String, mode: String, rounds: Int, pmLabel: String, pmModel: String, members: [GroupMember]) async -> String? {
        var body: JSON = ["title": title, "mode": mode, "rounds": rounds,
                          "members": members.map { m -> JSON in
                              var o: JSON = ["label": m.label.trimmingCharacters(in: .whitespaces), "role": m.role.trimmingCharacters(in: .whitespaces), "strengths": m.strengths.trimmingCharacters(in: .whitespaces)]
                              if !m.model.isEmpty { o["model"] = m.model }
                              return o
                          }]
        if mode == "pm" {
            var pm: JSON = ["label": pmLabel.trimmingCharacters(in: .whitespaces).isEmpty ? "产品经理" : pmLabel.trimmingCharacters(in: .whitespaces)]
            if !pmModel.isEmpty { pm["model"] = pmModel }
            body["pm"] = pm
        }
        do {
            let d = try await (id == nil ? app.api.call("POST", "/api/groups", json: body) : app.api.call("PATCH", "/api/groups/\(id!)", json: body))
            await load()
            if let saved = d.obj("group") { if id == nil { await open(saved.str("id")) } else { current = parse(saved) } }
            return nil
        } catch let e as ApiError { return e.message } catch { return error.localizedDescription }
    }

    func stop() { task?.cancel() }

    func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy, let group = current else { return }
        busy = true
        keySeq += 1; messages.append(GMsg(id: keySeq, role: "user", label: "你", content: text))
        task = Task {
            var live: [String: Int] = [:]   // 成员名 → 它正在写的那条消息的位置（成员可能并行发言）
            var failed: String? = nil
            do {
                for try await (event, data) in app.api.events("/api/groups/\(group.id)/send", json: ["message": text]) {
                    let label = data.str("label")
                    switch event {
                    case "turn_start":
                        keySeq += 1; messages.append(GMsg(id: keySeq, role: "agent", label: label, content: "", task: data.str("task"), streaming: true)); live[label] = messages.count - 1
                    case "delta":
                        if let i = live[label], messages.indices.contains(i) { messages[i].content += data.str("text") }
                    case "turn_end":
                        if let i = live.removeValue(forKey: label), messages.indices.contains(i) { messages[i].streaming = false }
                    case "note":
                        keySeq += 1; messages.append(GMsg(id: keySeq, role: "note", label: "", content: data.str("text")))
                    case "error": failed = data.str("error").isEmpty ? "群聊失败" : data.str("error")
                    default: break
                    }
                }
                if let failed { keySeq += 1; messages.append(GMsg(id: keySeq, role: "note", label: "", content: failed, error: true)) }
            } catch let e as ApiError {
                if e.status == 401 { app.sessionExpired() } else { keySeq += 1; messages.append(GMsg(id: keySeq, role: "note", label: "", content: e.message, error: true)) }
            } catch {}
            for i in messages.indices where messages[i].streaming { messages[i].streaming = false }
            busy = false
            await load()
            await app.loadUsage()
        }
    }
}

private func nameColor(_ label: String) -> Color {
    let hue = Double(label.unicodeScalars.reduce(7) { ($0 * 31 + Int($1.value)) % 360 }) / 360
    return Color(hue: hue, saturation: 0.5, brightness: 0.85)
}

// MARK: 入口：侧栏按钮打开的群聊页（列表 → 群聊）
struct GroupsSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    var body: some View {
        GroupsHome(g: model.groupModel)
            .frame(minWidth: 360, minHeight: 480)
    }
}

struct GroupsHome: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @ObservedObject var g: GroupModel
    @State private var editing: GroupEditTarget? = nil
    @State private var deleting: GroupInfo? = nil
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section { Text("把多个模型放进一个群，每个模型有自己的身份。选“产品经理带队”时，你只和产品经理说话，它会按各模型的擅长分配任务，再汇总答复你。").font(.footnote).foregroundStyle(.secondary) }
                Section {
                    if g.groups.isEmpty { Text("还没有群聊。点右上角“新建”。").foregroundStyle(.secondary) }
                    ForEach(g.groups) { item in
                        Button { Task { await g.open(item.id); path = [item.id] } } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack { Text("👥 " + item.title).fontWeight(.semibold).lineLimit(1); Spacer(); Text(groupModeLabel(item.mode).components(separatedBy: "（").first ?? "").font(.caption).foregroundStyle(accent) }
                                Text(item.members.map { $0.label }.joined(separator: "、")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        .swipeActions { Button("删除", role: .destructive) { deleting = item } }
                        .contextMenu { Button("删除", role: .destructive) { deleting = item } }
                    }
                }
            }
            .navigationTitle("群聊（多智能体）")
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("新建") { editing = GroupEditTarget(group: nil) } }
            }
            .navigationDestination(for: String.self) { _ in GroupChatView(g: g, onEdit: { editing = GroupEditTarget(group: g.current) }) }
            .task { await g.load() }
        }
        .sheet(item: $editing) { target in GroupEditor(g: g, group: target.group) }
        .confirmationDialog("删除群聊", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { item in
            Button("删除", role: .destructive) { Task { await g.delete(item.id) } }
        } message: { item in Text("确定删除「\(item.title)」和它的全部记录吗？") }
    }
}

struct GroupEditTarget: Identifiable { let id = UUID(); let group: GroupInfo? }

// MARK: 群聊页
struct GroupChatView: View {
    @ObservedObject var g: GroupModel
    var onEdit: () -> Void
    @State private var text = ""

    var body: some View {
        VStack(spacing: 0) {
            if let group = g.current, !group.members.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(group.members) { m in
                            Button { text += (text.isEmpty || text.hasSuffix(" ") ? "" : " ") + "@" + m.label + " " } label: {
                                Text(m.label + (m.role.isEmpty ? "" : " · " + m.role)).font(.caption).padding(.horizontal, 10).padding(.vertical, 4)
                                    .overlay(Capsule().stroke(nameColor(m.label)))
                            }.buttonStyle(.plain)
                        }
                    }.padding(.horizontal, 12).padding(.vertical, 8)
                }
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        if g.messages.isEmpty {
                            Text(g.current?.mode == "pm" ? "说出你的需求，产品经理会按每位成员的擅长分工，再汇总答复你。" : "发一条消息开始。用 @名称 可以点名某位成员。")
                                .foregroundStyle(.secondary).multilineTextAlignment(.center).padding(32)
                        }
                        ForEach(g.messages) { m in row(m).id(m.id) }
                    }.padding(12)
                }
                .onChange(of: g.messages.last?.content) { _, _ in if let id = g.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                .onChange(of: g.messages.count) { _, _ in if let id = g.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
            }
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField(g.current?.mode == "pm" ? "说出你的需求…" : "发消息，@名称 点名", text: $text, axis: .vertical).lineLimit(1...5).textFieldStyle(.roundedBorder)
                if g.busy { Button("停止") { g.stop() }.buttonStyle(.borderedProminent) }
                else { Button { let t = text; text = ""; g.send(t) } label: { Image(systemName: "paperplane.fill") }.disabled(text.trimmingCharacters(in: .whitespaces).isEmpty) }
            }.padding(10)
        }
        .navigationTitle(g.current?.title ?? "群聊")
        .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("设置") { onEdit() }.disabled(g.busy) } }
    }

    @ViewBuilder private func row(_ m: GMsg) -> some View {
        if m.role == "note" {
            Text(m.content).font(.caption).foregroundColor(m.error ? .red : .secondary).frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let mine = m.role == "user"
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(m.label).font(.caption.weight(.semibold)).foregroundColor(mine ? .secondary : nameColor(m.label))
                    if !m.task.isEmpty { Text("任务：" + m.task).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                }
                Text(m.content.isEmpty && m.streaming ? "…" : m.content).textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .foregroundColor(mine ? .white : .primary)
                    .background(mine ? AnyShapeStyle(accent.opacity(0.85)) : AnyShapeStyle(.regularMaterial), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }.frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        }
    }
}

// MARK: 新建 / 编辑
struct GroupEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @ObservedObject var g: GroupModel
    let group: GroupInfo?
    @State private var title = ""
    @State private var mode = "pm"
    @State private var rounds = 4
    @State private var pmLabel = "产品经理"
    @State private var pmModel = ""
    @State private var members: [GroupMember] = []
    @State private var error = ""
    @State private var saving = false
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("群聊名称", text: $title) }
                Section("方式") {
                    Picker("方式", selection: $mode) { ForEach(groupModes, id: \.id) { Text($0.label).tag($0.id) } }
                    if mode == "pm" {
                        TextField("产品经理名称", text: $pmLabel)
                        Picker("产品经理用的模型", selection: $pmModel) { Text("默认模型").tag(""); ForEach(model.models) { Text($0.label).tag($0.ref) } }
                        Text("建议选最强的推理模型。").font(.caption).foregroundStyle(.secondary)
                    }
                    Stepper(mode == "pm" ? "最多分配 \(rounds) 轮" : "讨论 \(rounds) 轮", value: $rounds, in: 1...(mode == "pm" ? 6 : 4))
                }
                Section {
                    ForEach($members) { $m in
                        VStack(alignment: .leading, spacing: 6) {
                            TextField("名称（不含空格）", text: $m.label)
                            Picker("模型", selection: $m.model) { Text("默认模型").tag(""); ForEach(model.models) { Text($0.label).tag($0.ref) } }
                                .onChange(of: m.model) { _, ref in
                                    guard let info = model.models.first(where: { $0.ref == ref }) else { return }
                                    let h = groupHint(info.ref + " " + info.label)
                                    if m.role.trimmingCharacters(in: .whitespaces).isEmpty { m.role = h.role }
                                    if m.strengths.trimmingCharacters(in: .whitespaces).isEmpty { m.strengths = h.strengths }
                                    if m.label.trimmingCharacters(in: .whitespaces).isEmpty { m.label = groupSafeName(info.label) }
                                }
                            TextField("身份，如“后端工程师”", text: $m.role)
                            TextField("擅长，如“写代码、排错”", text: $m.strengths, axis: .vertical)
                        }
                    }
                    .onDelete { members.remove(atOffsets: $0) }
                    Button("＋ 添加成员") { if members.count < 12 { members.append(GroupMember(label: "成员\(members.count + 1)")) } }
                    Button("＋ 加入我能用的所有模型") { members += g.allModelMembers(existing: members) }
                } header: { Text("成员（最多 12 位）") } footer: { Text("每个模型一个身份。产品经理会根据“擅长”把任务分给最合适的人；身份和擅长是按模型名给的默认建议，可以随意修改。左滑可删除成员。") }
                if !error.isEmpty { Section { Text(error).foregroundColor(.red).font(.footnote) } }
            }
            .navigationTitle(group == nil ? "新建群聊" : "群聊设置")
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "保存") {
                        saving = true; error = ""
                        Task {
                            let err = await g.save(id: group?.id, title: title, mode: mode, rounds: rounds, pmLabel: pmLabel, pmModel: pmModel, members: members)
                            saving = false
                            if let err { error = err } else { dismiss() }
                        }
                    }.disabled(saving)
                }
            }
            .onAppear {
                guard !loaded else { return }; loaded = true
                if let group { title = group.title; mode = group.mode; rounds = group.rounds; pmLabel = group.pmLabel; pmModel = group.pmModel; members = group.members }
                else { let all = g.allModelMembers(); members = all.isEmpty ? [GroupMember(label: "成员甲"), GroupMember(label: "成员乙")] : all }
            }
        }
        .frame(minWidth: 380, minHeight: 520)
    }
}
