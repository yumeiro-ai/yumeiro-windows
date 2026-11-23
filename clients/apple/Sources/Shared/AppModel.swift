import Foundation
import SwiftUI
import ImageIO

@MainActor
final class AppModel: ObservableObject {
    let session = Session()
    let api: ApiClient

    @Published var screen: Screen = .loading
    @Published var loginBusy = false
    @Published var loginError = ""
    @Published var serverInput = ""
    @Published var emailInput = ""
    @Published var passwordInput = ""
    @Published var ignoreCertInput = false

    @Published var me: JSON = [:]
    @Published var convs: [Conv] = []
    @Published var models: [ModelOpt] = []
    @Published var selectedModel = ""
    @Published var currentId: String? = nil
    @Published var title = "新对话"
    @Published var messages: [Msg] = []
    @Published var pending: [Pending] = []
    @Published var busy = false
    @Published var toast = ""
    @Published var usage = ""
    @Published var memories: [MemoryItem] = []
    @Published var memEnabled = true
    @Published var memAuto = true
    @Published var memCross = true
    @Published var agents: [AgentOpt] = []
    @Published var selectedAgent = ""
    @Published var skills: [SkillItem] = []
    @Published var market: [MarketItem] = []
    @Published var workspaces: [Workspace] = []
    @Published var activeWorkspace: Workspace? = nil
    @Published var members: [Member] = []
    @Published var usageRows: [Member] = []
    @Published var usageMonth = ""
    @Published var mcp: [McpItem] = []
    private var mcpRaw: [JSON] = []
    @Published var themeMode: String
    @Published var fontScale: Double
    @Published var wallItems: [WallItem] = []
    @Published var wallpaper = ""
    @Published var wallDim = 35
    @Published var wallImage: CGImage? = nil
    @Published var wallGradient: [Color]? = nil
    @Published var page: Page? = nil

    var maxImages = 4, maxFiles = 5, maxImageMb = 8, maxDocKb = 8192
    private var keySeq = 0
    private var chatTask: Task<Void, Never>?
    private var imageCache: [String: CGImage] = [:]

    var isAdmin: Bool { me.str("role") == "admin" }

    init() {
        api = ApiClient(session: session)
        themeMode = session.themeMode
        fontScale = session.fontScale
        serverInput = session.server; emailInput = session.email; ignoreCertInput = session.ignoreCert
        wallpaper = session.wallpaperChoice; wallDim = session.wallpaperDim
        Task { await showWallpaper() }   // 壁纸在本机，登录前也能显示
        Task { await restore() }
    }

    func say(_ text: String) { toast = text }

    /// 统一的请求包装：401 回到登录页，其它错误弹提示。
    @discardableResult
    func guarded<T>(quiet: Bool = false, _ work: () async throws -> T) async -> T? {
        do { return try await work() }
        catch let e as ApiError { if e.status == 401 { expired() } else if !quiet { say(e.message) } }
        catch { if !quiet { say(error.localizedDescription) } }
        return nil
    }

    func expired() { session.clearLogin(); passwordInput = ""; loginError = "登录已过期，请重新登录"; screen = .login }

    // MARK: 登录 / 退出
    func restore() async {
        if session.server.isEmpty || !session.hasLogin { screen = .login; return }
        do {
            if let info = try await api.checkSession() { me = info; enterApp() } else { loginError = "登录已过期，请重新登录"; screen = .login }
        } catch { loginError = ((error as? ApiError)?.message ?? error.localizedDescription) + "（请检查网络，或重新登录）"; screen = .login }
    }

    func login() async {
        let server = normalizeServer(serverInput)
        let email = emailInput.trimmingCharacters(in: .whitespaces)
        if server.isEmpty || email.isEmpty || passwordInput.isEmpty { loginError = "请填写服务器地址、邮箱和密码"; return }
        loginBusy = true; loginError = ""
        session.server = server; session.email = email; session.ignoreCert = ignoreCertInput; session.clearLogin()
        defer { loginBusy = false }
        do {
            let typedScheme = serverInput.lowercased().hasPrefix("http")
            do { me = try await api.login(email: email, password: passwordInput) }
            catch let e as ApiError {
                // 没写 http/https 时先试 https，服务器不支持就自动改用 http
                if !typedScheme && e.message.hasPrefix(httpsUnsupported) { session.server = "http://" + server.replacingOccurrences(of: "https://", with: ""); me = try await api.login(email: email, password: passwordInput) }
                else { throw e }
            }
            passwordInput = ""; serverInput = session.server; enterApp()
        } catch { loginError = (error as? ApiError)?.message ?? error.localizedDescription }
    }

    func logout() async {
        stop()
        await api.logout()
        convs = []; messages = []; pending = []; currentId = nil; title = "新对话"; me = [:]; workspaces = []; activeWorkspace = nil; page = nil
        screen = .login
    }

    private func enterApp() {
        screen = .chat
        Task { await loadConvs(); await loadModels(); await loadConfig(); await loadUsage(); await loadAgents(); await loadMemories(); await loadWallpaperLibrary(); await showWallpaper(); await loadWorkspaces() }
    }

    // MARK: 数据
    func loadConvs() async {
        guard let d = await guarded({ try await api.call("GET", "/api/conversations") }) else { return }
        convs = d.list("conversations").map { Conv(id: $0.str("id"), title: $0.str("title").isEmpty ? "新对话" : $0.str("title"), updatedAt: ($0["updatedAt"] as? Double) ?? 0) }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func loadModels() async {
        guard let d = await guarded({ try await api.call("GET", "/api/models") }) else { return }
        let list = d.list("models").map { m -> ModelOpt in
            let label = m.str("label").isEmpty ? (m.str("model").isEmpty ? m.str("ref") : m.str("model")) : m.str("label")
            return ModelOpt(ref: m.str("ref"), label: label, provider: m.str("providerName"))
        }
        models = list
        let wanted = [session.defaultModel, d.str("defaultModel")].first { w in !w.isEmpty && list.contains { $0.ref == w } } ?? list.first?.ref ?? ""
        if selectedModel.isEmpty || !list.contains(where: { $0.ref == selectedModel }) { selectedModel = wanted }
    }

    func loadConfig() async {
        guard let c = await guarded(quiet: true, { try await api.call("GET", "/api/vision/config") }) else { return }
        maxImages = c["maxImages"] as? Int ?? 4; maxFiles = c["maxFiles"] as? Int ?? 5; maxImageMb = c["maxMb"] as? Int ?? 8; maxDocKb = c["maxDocKb"] as? Int ?? 8192
    }

    func loadUsage() async {
        guard let d = await guarded(quiet: true, { try await api.call("GET", "/api/usage/me") }) else { return }
        let u = d.obj("usage") ?? [:]
        let limit = u.int("monthlyCallLimit")
        usage = "本月 \(u.int("calls"))" + (limit > 0 ? " / \(limit)" : "") + " 次"
    }

    func chooseModel(_ ref: String) { selectedModel = ref; session.defaultModel = ref }

    // MARK: 对话
    func newChat() { if busy { return }; currentId = nil; title = "新对话"; messages = [] }

    func openConv(_ id: String) async {
        if busy { return }
        guard let d = await guarded({ try await api.call("GET", "/api/conversations/\(id)") }) else { return }
        currentId = id
        let conv = d.obj("conversation") ?? [:]
        title = conv.str("title").isEmpty ? "新对话" : conv.str("title")
        let m = conv.str("model"); if !m.isEmpty, models.contains(where: { $0.ref == m }) { selectedModel = m }
        messages = d.list("messages").map { item in
            let imgs = item.list("images").map { AttRef(attId: $0.str("id"), name: $0.str("name").isEmpty ? "图片" : $0.str("name"), image: true) }
            let files = item.list("files").map { AttRef(attId: $0.str("id"), name: $0.str("name").isEmpty ? "文件" : $0.str("name"), image: false) }
            keySeq += 1
            return Msg(id: keySeq, role: item.str("role") == "user" ? "user" : "assistant", content: item.str("content"), atts: imgs + files)
        }
    }

    func renameConv(_ newTitle: String) async {
        guard let id = currentId else { return }
        let t = String(newTitle.trimmingCharacters(in: .whitespaces).prefix(60)); if t.isEmpty { return }
        if await guarded({ try await api.call("PATCH", "/api/conversations/\(id)", json: ["title": t]) }) != nil { title = t; await loadConvs() }
    }

    func deleteConv(_ id: String) async {
        if await guarded({ try await api.call("DELETE", "/api/conversations/\(id)") }) != nil { if currentId == id { newChat() }; await loadConvs() }
    }

    func transcript() -> String { messages.map { ($0.role == "user" ? "## 我\n" : "## Yumeiro\n") + $0.content }.joined(separator: "\n\n") }

    // MARK: 附件
    func addFile(name: String, data: Data) {
        let ext = (name as NSString).pathExtension.lowercased()
        let image = ["png", "jpg", "jpeg", "webp", "gif", "heic"].contains(ext)
        let same = pending.filter { $0.image == image }.count
        if image && same >= maxImages { say("一条消息最多带 \(maxImages) 张图片"); return }
        if !image && same >= maxFiles { say("一条消息最多带 \(maxFiles) 个文件"); return }
        if data.isEmpty { say("\(name)：文件是空的"); return }
        let limit = image ? maxImageMb * 1_048_576 : maxDocKb * 1024
        if data.count > limit { say("\(name)：太大了（上限 \(limit / 1_048_576) MB）"); return }
        var upload = data; var uploadName = name
        if ext == "heic", let cg = makeThumbnail(data, maxSize: 3000), let jpeg = jpegData(cg) { upload = jpeg; uploadName = (name as NSString).deletingPathExtension + ".jpg" }
        let item = Pending(name: uploadName, image: image, thumb: image ? makeThumbnail(upload, maxSize: 400) : nil)
        pending.append(item)
        item.task = Task { [weak self, weak item] in
            guard let self = self, let item = item else { return }
            do {
                let att = try await self.api.upload(name: uploadName, data: upload) { sent, total in
                    Task { @MainActor in item.pct = min(99, Int(sent * 100 / max(total, 1))); if sent >= total { item.processing = true } }
                }
                if item.cancelled { _ = try? await self.api.call("DELETE", "/api/attachments/\(att.str("id"))") } else { item.attId = att.str("id") }
            } catch let e as ApiError {
                self.pending.removeAll { $0 === item }
                if e.status == 401 { self.expired() } else if !item.cancelled { self.say("\(uploadName)：\(e.message)") }
            } catch { self.pending.removeAll { $0 === item } }
        }
    }

    private func jpegData(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }

    func removePending(_ item: Pending) {
        pending.removeAll { $0 === item }
        if item.done { Task { _ = await guarded(quiet: true, { try await api.call("DELETE", "/api/attachments/\(item.attId)") }) } }
        else { item.cancelled = true; item.task?.cancel() }
    }

    /// 历史消息里的图片：向服务器取（带登录状态），缓存缩略图。
    func attachmentImage(_ id: String) async -> CGImage? {
        if let c = imageCache[id] { return c }
        guard let r = try? await api.bytes("/api/attachments/\(id)"), let img = makeThumbnail(r.data, maxSize: 1200) else { return nil }
        imageCache[id] = img; return img
    }

    func attachmentText(_ id: String) async -> String {
        do { return String(decoding: try await api.bytes("/api/attachments/\(id)").data, as: UTF8.self) } catch { return "读取失败：\((error as? ApiError)?.message ?? error.localizedDescription)" }
    }

    // MARK: 发送
    func send(_ raw: String) {
        if busy { return }
        let text0 = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let ready = pending.filter { $0.done }
        if text0.isEmpty && ready.isEmpty { return }
        if pending.contains(where: { !$0.done }) { say("附件还在上传，请稍候"); return }
        if models.isEmpty { say("服务器还没有配置模型，请联系管理员"); return }
        let text = text0.isEmpty ? (ready.allSatisfy { !$0.image } ? "请阅读我上传的文件，并总结其中的要点。" : "请看这张图片，描述并分析其中的内容。") : text0
        let ids = ready.map { $0.attId }
        let shown = ready.map { AttRef(attId: $0.attId, name: $0.name, image: $0.image, thumb: $0.thumb) }
        pending = []
        busy = true
        chatTask = Task { [weak self] in
            guard let self = self else { return }
            var assistantId = -1
            defer { self.busy = false; Task { await self.loadConvs(); await self.loadUsage() } }
            do {
                if self.currentId == nil {
                    var body: JSON = ["model": self.selectedModel]
                    if !self.selectedAgent.isEmpty { body["agent_id"] = self.selectedAgent }
                    let c = try await self.api.call("POST", "/api/conversations", json: body)
                    guard let conv = c.obj("conversation") else { throw ApiError(message: "创建对话失败") }
                    self.currentId = conv.str("id")
                    self.convs.insert(Conv(id: conv.str("id"), title: conv.str("title").isEmpty ? "新对话" : conv.str("title"), updatedAt: Date().timeIntervalSince1970 * 1000), at: 0)
                }
                self.keySeq += 2
                self.messages.append(Msg(id: self.keySeq - 1, role: "user", content: text, atts: shown))
                assistantId = self.keySeq
                self.messages.append(Msg(id: assistantId, role: "assistant", content: ""))
                var body: JSON = ["conversation_id": self.currentId ?? "", "message": text]
                if !ids.isEmpty { body["attachments"] = ids }
                var acc = ""
                for try await (event, data) in self.api.events("/api/chat/stream", json: body) {
                    switch event {
                    case "delta": acc += data.str("text"); self.update(assistantId) { $0.content = acc }
                    case "error": let m = data.str("error"); self.update(assistantId) { $0.content = m.isEmpty ? "回复失败" : m; $0.error = true }
                    case "done": if let t = data.obj("conversation")?.str("title"), !t.isEmpty { self.title = t }
                    default: break
                    }
                }
            } catch let e as ApiError {
                if e.status == 401 { self.expired() }
                else if assistantId >= 0 { self.update(assistantId) { $0.content = e.message; $0.error = true } } else { self.say(e.message) }
            } catch is CancellationError { }
            catch { if assistantId >= 0 { self.update(assistantId) { $0.content = error.localizedDescription; $0.error = true } } }
        }
    }

    private func update(_ id: Int, _ change: (inout Msg) -> Void) {
        if let i = messages.firstIndex(where: { $0.id == id }) { change(&messages[i]) }
    }

    func stop() { chatTask?.cancel() }

    // MARK: 分组
    func grouped() -> [(String, [Conv])] {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date()).timeIntervalSince1970 * 1000, day = 86_400_000.0
        func label(_ t: Double) -> String { t >= today ? "今天" : t >= today - day ? "昨天" : t >= today - 7 * day ? "最近 7 天" : "更早" }
        var order: [String] = []; var map: [String: [Conv]] = [:]
        for c in convs { let l = label(c.updatedAt); if map[l] == nil { order.append(l) }; map[l, default: []].append(c) }
        return order.map { ($0, map[$0] ?? []) }
    }

    // MARK: 记忆
    func loadMemories() async {
        guard let d = await guarded(quiet: true, { try await api.call("GET", "/api/memories") }) else { return }
        memories = d.list("memories").map { MemoryItem(id: $0.str("id"), text: $0.str("text"), pinned: $0.bool("pinned")) }
        if let p = d.obj("prefs") { memEnabled = p.bool("enabled", true); memAuto = p.bool("auto", true); memCross = p.bool("crossChat", true) }
    }
    func setMemPref(_ key: String, _ value: Bool) async {
        switch key { case "enabled": memEnabled = value; case "auto": memAuto = value; default: memCross = value }
        if await guarded({ try await api.call("PUT", "/api/memory/prefs", json: [key: value]) }) == nil { await loadMemories() }
    }
    func addMemory(_ text: String) async { if await guarded({ try await api.call("POST", "/api/memories", json: ["text": text, "kind": "note"]) }) != nil { await loadMemories(); say("已记住") } }
    func deleteMemory(_ id: String) async { if await guarded({ try await api.call("DELETE", "/api/memories/\(id)") }) != nil { memories.removeAll { $0.id == id } } }
    func clearMemories() async { if await guarded({ try await api.call("DELETE", "/api/memories") }) != nil { memories = []; say("已清空记忆") } }

    func changePassword(old: String, new: String) async -> String? {
        if new.count < 16 { return "新密码至少需要 16 个字符" }
        do { try await api.call("POST", "/api/auth/change-password", json: ["currentPassword": old, "newPassword": new]); say("密码已修改，其它设备需要重新登录"); return nil }
        catch { return (error as? ApiError)?.message ?? error.localizedDescription }
    }

    // MARK: 主题 / 壁纸
    func setTheme(_ mode: String) { themeMode = mode; session.themeMode = mode }
    func setFont(_ scale: Double) { fontScale = scale; session.fontScale = scale }

    // 壁纸只保存在这台设备上（UserDefaults + Application Support 里的一份图片），不读也不写服务器上的壁纸偏好和默认壁纸。
    private var wallpaperFileURL: URL? {
        guard let base = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        let dir = base.appendingPathComponent("Yumeiro", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("wallpaper.jpg")
    }

    /// 设置页里显示的当前壁纸名称
    var wallpaperLabel: String {
        if wallpaper.isEmpty { return "无" }
        if wallpaper == "local" { return "本机图片" }
        if wallpaper.hasPrefix("server:") { return String(wallpaper.dropFirst(7)) }
        return wallPresets.first { "preset:" + $0.id == wallpaper }?.label ?? "无"
    }

    /// 只读取服务器壁纸库的列表，供“从服务器壁纸库选一张”使用；不看服务器上的 pref / defaultWallpaper
    func loadWallpaperLibrary() async {
        guard let d = await guarded(quiet: true, { try await api.call("GET", "/api/wallpapers") }) else { return }
        wallItems = d.list("items").map { WallItem(name: $0.str("name"), kind: $0.str("kind")) }
        if wallpaper.hasPrefix("server:") {
            let name = String(wallpaper.dropFirst(7))
            if !wallItems.contains(where: { $0.name == name && $0.kind == "image" }) { forgetWallpaper() }   // 服务器上已经没有这张：悄悄改回无壁纸
        }
    }

    private func forgetWallpaper() {
        wallpaper = ""; session.wallpaperChoice = ""; wallImage = nil; wallGradient = nil
    }

    func chooseWallpaper(_ choice: String) async {
        wallpaper = choice; session.wallpaperChoice = choice
        if choice != "local", let url = wallpaperFileURL { try? FileManager.default.removeItem(at: url) }
        await showWallpaper()
    }

    func chooseWallDim(_ dim: Int) { wallDim = dim; session.wallpaperDim = dim }

    /// 用设备上选的图片做壁纸：校验能解码、缩小到 2200 像素以内后存进 App 自己的目录。返回错误文字，成功返回 nil
    func setLocalWallpaper(_ data: Data) async -> String? {
        if data.isEmpty { return "图片是空的" }
        if data.count > 40 * 1_048_576 { return "图片太大了（上限 40 MB）" }
        guard let cg = makeThumbnail(data, maxSize: 2200) else { return "这个文件不是可以读取的图片" }
        guard let jpeg = jpegData(cg), let url = wallpaperFileURL else { return "保存失败" }
        do { try jpeg.write(to: url, options: .atomic) } catch { return "保存失败：" + error.localizedDescription }
        wallpaper = "local"; session.wallpaperChoice = "local"
        wallImage = cg; wallGradient = nil
        return nil
    }

    /// 按本机记住的选择显示壁纸；没有选择就是没有壁纸（不回退到服务器默认）
    func showWallpaper() async {
        let choice = wallpaper
        if let preset = wallPresets.first(where: { "preset:" + $0.id == choice }) { wallGradient = preset.colors; wallImage = nil; return }
        wallGradient = nil
        if choice == "local" {
            if let url = wallpaperFileURL, let data = try? Data(contentsOf: url), let cg = makeThumbnail(data, maxSize: 2200) { wallImage = cg } else { forgetWallpaper() }
            return
        }
        guard choice.hasPrefix("server:") else { wallImage = nil; return }
        let name = String(choice.dropFirst(7))
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        do {
            let r = try await api.bytes("/api/wallpapers/file/\(encoded)", maxBytes: 12 * 1_048_576)
            guard wallpaper == choice else { return }
            if let img = makeThumbnail(r.data, maxSize: 1800) { wallImage = img } else { forgetWallpaper() }
        } catch let e as ApiError {
            guard wallpaper == choice else { return }
            if e.status == 404 { forgetWallpaper() } else { wallImage = nil }   // 网络或登录问题：先不显示，选择保留
        } catch { if wallpaper == choice { wallImage = nil } }
    }

    // MARK: 智能体 / 技能 / 市场
    func loadAgents() async {
        guard let d = await guarded(quiet: true, { try await api.call("GET", "/api/agents") }) else { return }
        agents = d.list("agents").map { AgentOpt(id: $0.str("id"), name: $0.str("name"), description: $0.str("description"), mine: $0.bool("mine"), systemPrompt: $0.str("systemPrompt"), model: $0.str("model"), skillIds: ($0["skillIds"] as? [String]) ?? [], shared: $0.bool("shared")) }
        if !agents.contains(where: { $0.id == selectedAgent }) { selectedAgent = "" }
    }
    func saveAgent(id: String?, name: String, description: String, prompt: String, model: String, skillIds: [String], shared: Bool) async -> String? {
        var body: JSON = ["name": name, "description": description, "systemPrompt": prompt, "model": model, "skillIds": skillIds]
        if isAdmin { body["shared"] = shared }
        do { if let id = id { try await api.call("PATCH", "/api/agents/\(id)", json: body) } else { try await api.call("POST", "/api/agents", json: body) }; await loadAgents(); return nil }
        catch { return (error as? ApiError)?.message ?? error.localizedDescription }
    }
    func deleteAgent(_ id: String) async { if await guarded({ try await api.call("DELETE", "/api/agents/\(id)") }) != nil { if selectedAgent == id { selectedAgent = "" }; await loadAgents() } }

    func loadSkills() async {
        guard let d = await guarded({ try await api.call("GET", "/api/skills") }) else { return }
        skills = d.list("skills").map { SkillItem(id: $0.str("id"), title: $0.str("title"), description: $0.str("description"), content: $0.str("content"), shared: $0.bool("shared"), mine: $0.bool("mine")) }
    }
    func saveSkill(id: String?, title: String, description: String, content: String, shared: Bool) async -> String? {
        var body: JSON = ["title": title, "description": description, "content": content]
        if isAdmin { body["shared"] = shared }
        do { if let id = id { try await api.call("PATCH", "/api/skills/\(id)", json: body) } else { try await api.call("POST", "/api/skills", json: body) }; await loadSkills(); await loadAgents(); return nil }
        catch { return (error as? ApiError)?.message ?? error.localizedDescription }
    }
    func deleteSkill(_ id: String) async { if await guarded({ try await api.call("DELETE", "/api/skills/\(id)") }) != nil { await loadSkills(); await loadAgents() } }

    func loadMarket() async {
        guard let d = await guarded({ try await api.call("GET", "/api/market") }) else { return }
        func parse(_ a: [JSON]) -> [MarketItem] { a.map { MarketItem(key: $0.str("key"), type: $0.str("type"), title: $0.str("title"), description: $0.str("description"), author: $0.str("author"), installed: $0.bool("installed")) } }
        market = parse(d.list("skills")) + parse(d.list("bots"))
    }
    func marketPreview(_ item: MarketItem) async -> String {
        let key = item.key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? item.key
        do { let d = try await api.call("GET", "/api/market/preview?key=\(key)"); let t = d.str("preview"); return t.isEmpty ? "（没有内容）" : t }
        catch { return (error as? ApiError)?.message ?? error.localizedDescription }
    }
    func installMarket(_ item: MarketItem) async {
        if await guarded({ try await api.call("POST", "/api/market/install", json: ["key": item.key, "type": item.type]) }) != nil { say("已安装：" + item.title); await loadMarket(); await loadSkills(); await loadAgents() }
    }

    /// 用服务器上的默认模型翻译成中文
    func translate(_ text: String) async throws -> String {
        try await api.call("POST", "/api/translate", json: ["text": text]).str("text")
    }

    // MARK: 网页找回密码的手机确认（仅管理员）
    @Published var approvals: [Approval] = []
    func loadApprovals() async {
        guard let d = await guarded(quiet: true, { try await api.call("GET", "/api/security/recovery") }) else { return }
        approvals = d.list("pending").map { Approval(code: $0.str("code"), ip: $0.str("ip"), ua: $0.str("ua"), expiresAt: ($0["expiresAt"] as? Double) ?? 0) }
    }
    /// code 是网页上显示的 6 位验证码；approve=false 表示拒绝。返回错误文字，成功返回 nil
    func decideApproval(code: String, approve: Bool) async -> String? {
        do {
            try await api.call("POST", "/api/security/phone-approve", json: ["code": code.filter { $0.isNumber }, "approve": approve])
            say(approve ? "已批准，网页那边会自动继续" : "已拒绝这次请求"); await loadApprovals(); return nil
        } catch { return (error as? ApiError)?.message ?? error.localizedDescription }
    }

    // MARK: 工作区成员
    private func parseWorkspaceMember(_ value: Any) -> WorkspaceMember? {
        if let email = value as? String, !email.isEmpty { return WorkspaceMember(id: email, email: email, name: email, disabled: false) }
        guard let item = value as? JSON else { return nil }
        let id = item.str("id").isEmpty ? item.str("userId") : item.str("id")
        let email = item.str("email")
        guard !id.isEmpty || !email.isEmpty else { return nil }
        return WorkspaceMember(id: id.isEmpty ? email : id, email: email, name: item.str("displayName").isEmpty ? (item.str("name").isEmpty ? email : item.str("name")) : item.str("displayName"), disabled: item.bool("disabled"))
    }

    private func parseWorkspace(_ item: JSON) -> Workspace {
        let rawMembers: [Any] = (item["members"] as? [Any]) ?? []
        return Workspace(id: item.str("id"), name: item.str("name"), createdAt: (item["createdAt"] as? Double) ?? 0, mine: item.bool("mine"), owner: item.str("owner"), members: rawMembers.compactMap(parseWorkspaceMember))
    }

    func loadWorkspaces() async {
        guard let d = await guarded(quiet: true, { try await api.call("GET", "/api/workspaces") }) else { return }
        workspaces = d.list("workspaces").map(parseWorkspace)
        if let current = activeWorkspace, let refreshed = workspaces.first(where: { $0.id == current.id }) { activeWorkspace = refreshed }
        else { activeWorkspace = workspaces.first }
    }

    func searchWorkspaceMembers(_ workspaceId: String, query: String) async -> [WorkspaceMember] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let encoded = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        guard let d = await guarded({ try await api.call("GET", "/api/workspaces/\(workspaceId)/members/search?q=\(encoded)") }) else { return [] }
        let values: [Any] = (d["members"] as? [Any]) ?? (d["users"] as? [Any]) ?? (d["results"] as? [Any]) ?? []
        return values.compactMap(parseWorkspaceMember)
    }

    func addWorkspaceMember(_ workspaceId: String, userId: String) async -> Bool {
        guard await guarded({ try await api.call("POST", "/api/workspaces/\(workspaceId)/members", json: ["userId": userId]) }) != nil else { return false }
        await loadWorkspaces(); return true
    }

    func removeWorkspaceMember(_ workspaceId: String, userId: String) async -> Bool {
        guard await guarded({ try await api.call("DELETE", "/api/workspaces/\(workspaceId)/members/\(userId)") }) != nil else { return false }
        await loadWorkspaces(); return true
    }

    // MARK: 管理（仅管理员）
    private func parseMember(_ m: JSON) -> Member {
        let month = m.obj("month")
        return Member(id: m.str("id"), email: m.str("email"), name: m.str("displayName").isEmpty ? m.str("email") : m.str("displayName"), disabled: m.bool("disabled"), todayCalls: m.int("todayCalls"), monthCalls: month?.int("calls") ?? m.int("calls"), tokens: month?.int("totalTokens") ?? m.int("totalTokens"))
    }
    func loadMembers() async { if let d = await guarded({ try await api.call("GET", "/api/admin/members") }) { members = d.list("members").map(parseMember) } }
    func createMember(email: String, name: String, password: String) async -> String? {
        do { try await api.call("POST", "/api/admin/members", json: ["email": email, "displayName": name, "password": password]); await loadMembers(); return nil }
        catch { return (error as? ApiError)?.message ?? error.localizedDescription }
    }
    func setMemberDisabled(_ id: String, _ disabled: Bool) async { if await guarded({ try await api.call("PATCH", "/api/admin/members/\(id)", json: ["disabled": disabled]) }) != nil { await loadMembers() } }
    func resetMemberPassword(_ id: String, _ password: String) async -> String? {
        do { try await api.call("PATCH", "/api/admin/members/\(id)", json: ["password": password]); say("密码已重置，该成员需重新登录"); return nil }
        catch { return (error as? ApiError)?.message ?? error.localizedDescription }
    }
    func deleteMember(_ id: String) async { if await guarded({ try await api.call("DELETE", "/api/admin/members/\(id)") }) != nil { await loadMembers() } }
    func loadUsageAll() async {
        guard let d = await guarded({ try await api.call("GET", "/api/admin/usage") }) else { return }
        usageMonth = d.str("month")
        usageRows = d.list("rows").map { r in let m = parseMember(r); return Member(id: m.id, email: m.email, name: m.name, disabled: m.disabled, todayCalls: m.todayCalls, monthCalls: r.int("calls"), tokens: r.int("totalTokens")) }
    }
    func loadMcp() async {
        guard let d = await guarded({ try await api.call("GET", "/api/admin/mcp") }) else { return }
        mcpRaw = d.list("servers")
        mcp = mcpRaw.map { s in McpItem(name: s.str("name"), command: (s.str("command") + " " + (((s["args"] as? [String]) ?? []).joined(separator: " "))).trimmingCharacters(in: .whitespaces), enabled: s.bool("enabled", true)) }
    }
    func toggleMcp(_ name: String, _ enabled: Bool) async {
        var copy = mcpRaw
        for i in copy.indices where copy[i].str("name") == name { copy[i]["enabled"] = enabled }
        if await guarded({ try await api.call("PUT", "/api/admin/mcp", json: ["servers": copy]) }) != nil { await loadMcp(); say(enabled ? "已启用 \(name)" : "已停用 \(name)") }
    }
}
