import SwiftUI

// 管理员页面里的“安全与熔断 / 套餐与授权 / 模型价格 / 站点设置”。
// 这些都是服务器上的设置，改动对所有人生效；服务器自己也会检查管理员身份。
// 写在一个单独的文件里，只通过 model.api 调用服务器，不改动其他页面的逻辑。

private func text(_ v: Any?) -> String { (v as? String) ?? "" }
private func number(_ v: Any?) -> String {
    if let d = v as? Double { return d == d.rounded() ? String(Int(d)) : String(d) }
    if let i = v as? Int { return String(i) }
    return ""
}
private func stamp(_ ms: Any?) -> String {
    let t = (ms as? Double) ?? Double((ms as? Int) ?? 0)
    if t <= 0 { return "" }
    let f = DateFormatter(); f.dateFormat = "MM-dd HH:mm"
    return f.string(from: Date(timeIntervalSince1970: t / 1000))
}

struct AdminExtraView: View {
    let tab: Int   // 3 安全与熔断；4 套餐与授权；5 模型价格；6 站点设置
    var body: some View {
        switch tab {
        case 3: AdminSecurityView()
        case 4: AdminPlanView()
        case 5: AdminPricingView()
        default: AdminSiteView()
        }
    }
}

// MARK: - 安全与熔断
struct AdminSecurityView: View {
    @EnvironmentObject var model: AppModel
    @State private var loaded = false
    @State private var dlpOn = false
    @State private var dlpBlock = true
    @State private var builtin: [String: Bool] = [:]
    @State private var keywords = ""
    @State private var emailOn = false
    @State private var emailDomains = ""
    @State private var breakerOn = true
    @State private var threshold = "5"
    @State private var openSeconds = "60"
    @State private var rate = "30"
    @State private var dayLimit = "0"
    @State private var monthLimit = "0"
    @State private var currency = "¥"
    @State private var modelStates: [JSON] = []
    @State private var userStates: [JSON] = []
    @State private var events: [JSON] = []
    @State private var labeled: [String] = []
    @State private var allowText = ""
    @State private var saving = false
    private let builtinRows: [(String, String)] = [("idcard", "身份证号（带校验）"), ("bank", "银行卡号（带校验）"), ("secret", "密钥 / 令牌"), ("phone", "手机号"), ("email", "邮箱地址")]
    private let kinds: [String: String] = ["dlp": "敏感内容", "confidential": "机密工作区", "breaker": "模型熔断", "abuse": "请求过快", "cost": "费用上限"]

    var body: some View {
        List {
            Section { Text("这里只记录“谁、什么时候、命中了什么规则”，不会记录或显示被检测的内容本身。").font(.caption).foregroundStyle(.secondary) }
            Section("注册邮箱限制") {
                Toggle("只允许公司邮箱注册", isOn: $emailOn)
                TextField("公司邮箱域名，每行一个，例如 example.com", text: $emailDomains, axis: .vertical).lineLimit(2...5)
                Text("开启后，邀请、新建成员都只接受这些域名的邮箱（完整匹配，子域名要单独写）。已有成员不受影响。").font(.caption2).foregroundStyle(.secondary)
            }
            Section("敏感内容拦截") {
                Toggle("启用", isOn: $dlpOn)
                Picker("命中后", selection: $dlpBlock) { Text("拦截并告警").tag(true); Text("只警告").tag(false) }
                ForEach(builtinRows, id: \.0) { row in
                    Toggle(row.1, isOn: Binding(get: { builtin[row.0] ?? false }, set: { builtin[row.0] = $0 }))
                }
                TextField("自定义关键词，每行一个", text: $keywords, axis: .vertical).lineLimit(2...6)
                Text("自定义正则和“机密工作区允许名单”请在网页版里设置；这里保存时会原样保留它们。").font(.caption2).foregroundStyle(.secondary)
                if !labeled.isEmpty { Text("当前机密工作区：" + labeled.joined(separator: "、")).font(.caption).foregroundStyle(.secondary) }
            }
            Section("熔断与费用上限") {
                Toggle("启用熔断", isOn: $breakerOn)
                field("模型连续失败几次就熔断", $threshold)
                field("熔断后先断开多少秒再试探", $openSeconds)
                field("单人每分钟最多请求（0 不限）", $rate)
                field("每日费用上限 \(currency)（0 不限）", $dayLimit)
                field("每月费用上限 \(currency)（0 不限）", $monthLimit)
            }
            Section { Button(saving ? "正在保存…" : "保存") { Task { await save() } }.disabled(saving || !loaded) }
            Section("实时状态") {
                if modelStates.isEmpty && userStates.isEmpty { Text("还没有模型被调用过。").foregroundStyle(.secondary) }
                ForEach(Array(modelStates.enumerated()), id: \.offset) { _, s in
                    let open = text(s["state"]) != "closed"
                    HStack {
                        VStack(alignment: .leading) {
                            Text(text(s["state"]) == "open" ? ((s["manual"] as? Bool ?? false) ? "已手动暂停" : "已熔断") : (text(s["state"]) == "half" ? "试探中" : "正常")).font(.headline)
                            Text(text(s["key"])).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer()
                        Button(open ? "立即恢复" : "手动暂停") { Task { await act(["action": open ? "reset" : "trip", "key": text(s["key"])]) } }.buttonStyle(.bordered)
                    }
                }
                ForEach(Array(userStates.enumerated()), id: \.offset) { _, u in
                    HStack {
                        Text("\(text(u["email"]).isEmpty ? text(u["userId"]) : text(u["email"]))　请求太快，暂停中")
                        Spacer()
                        Button("解除") { Task { await act(["action": "reset-user", "userId": text(u["userId"])]) } }.buttonStyle(.bordered)
                    }
                }
            }
            Section("告警记录（最近 50 条）") {
                if events.isEmpty { Text("暂时没有告警。").foregroundStyle(.secondary) }
                ForEach(Array(events.prefix(50).enumerated()), id: \.offset) { _, e in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("[\(kinds[text(e["kind"])] ?? text(e["kind"]))] \(text(e["summary"]))").font(.subheadline)
                        Text(stamp(e["at"]) + (text(e["email"]).isEmpty ? "" : "　" + text(e["email"]))).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .task { await load() }
    }

    private func field(_ title: String, _ value: Binding<String>) -> some View {
        HStack { Text(title); Spacer(); TextField("", text: value).multilineTextAlignment(.trailing).frame(maxWidth: 110) }
    }

    @State private var rawDlp: JSON = [:]

    private func load() async {
        guard let d = await model.guarded({ try await model.api.call("GET", "/api/admin/security") }) else { return }
        let dlp = d.obj("dlp") ?? [:], br = d.obj("breaker") ?? [:], em = d.obj("emailDomains") ?? [:]
        rawDlp = dlp
        dlpOn = dlp.bool("enabled"); dlpBlock = text(dlp["mode"]) != "warn"
        let b = dlp.obj("builtin") ?? [:]
        for row in builtinRows { builtin[row.0] = b.bool(row.0) }
        keywords = ((dlp["keywords"] as? [String]) ?? []).joined(separator: "\n")
        emailOn = em.bool("enabled"); emailDomains = ((em["domains"] as? [String]) ?? []).joined(separator: "\n")
        breakerOn = br.bool("enabled", true)
        threshold = number(br["failureThreshold"]); openSeconds = number(br["openSeconds"]); rate = number(br["userRatePerMinute"])
        dayLimit = number(br["dailyCostLimit"]); monthLimit = number(br["monthlyCostLimit"])
        currency = text(d["currency"]).isEmpty ? "¥" : text(d["currency"])
        let st = d.obj("states") ?? [:]
        modelStates = st.list("models"); userStates = st.list("users")
        events = d.list("events")
        labeled = d.list("labeled").map { text($0["name"]) }
        loaded = true
    }

    private func save() async {
        saving = true; defer { saving = false }
        var dlp: JSON = rawDlp   // 保留自定义正则和机密允许名单
        dlp["enabled"] = dlpOn; dlp["mode"] = dlpBlock ? "block" : "warn"
        dlp["builtin"] = Dictionary(uniqueKeysWithValues: builtinRows.map { ($0.0, builtin[$0.0] ?? false) })
        dlp["keywords"] = keywords.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let body: JSON = [
            "dlp": dlp,
            "emailDomains": ["enabled": emailOn, "domains": emailDomains] as JSON,
            "breaker": ["enabled": breakerOn, "failureThreshold": threshold, "openSeconds": openSeconds, "userRatePerMinute": rate, "dailyCostLimit": dayLimit, "monthlyCostLimit": monthLimit] as JSON,
        ]
        if await model.guarded({ try await model.api.call("PUT", "/api/admin/security", json: body) }) != nil { model.say("已保存，立即生效"); await load() }
    }

    private func act(_ payload: JSON) async {
        if await model.guarded({ try await model.api.call("POST", "/api/admin/security/breaker", json: payload) }) != nil { await load() }
    }
}

// MARK: - 套餐与授权（目前全部功能向所有人开放，只作介绍）
struct AdminPlanView: View {
    @EnvironmentObject var model: AppModel
    @State private var data: JSON = [:]
    var body: some View {
        List {
            Section("现在：全部功能向所有人开放") {
                Text("目前处于试用期，下面所有版本的功能都可以直接使用，不需要购买，也不需要授权密钥（当前 \(data.int("members")) 位成员）。").font(.subheadline)
                Text("正式版本发布后会开放购买：到时候按下面的版本分档，可以在线购买，或用授权密钥解锁完整功能。").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(data.list("tiers").enumerated()), id: \.offset) { _, t in
                Section(text(t["name"])) {
                    Text(text(t["blurb"])).font(.caption).foregroundStyle(.secondary)
                    Text("成员 \(t.int("seats") == 0 ? "不限" : String(t.int("seats")))　独立桌面 \(t.int("desktops") == 0 ? "无" : String(t.int("desktops")))").font(.caption)
                    ForEach(Array(data.list("features").filter { text($0["tier"]) == text(t["id"]) }.enumerated()), id: \.offset) { _, f in
                        Text("• " + text(f["name"]) + (text(f["status"]) == "planned" ? "（规划中）" : ""))
                    }
                    Button("即将开放购买") { }.disabled(true)
                }
            }
        }
        .task { if let d = await model.guarded({ try await model.api.call("GET", "/api/admin/plan") }) { data = d } }
    }
}

// MARK: - 模型价格
struct AdminPricingView: View {
    @EnvironmentObject var model: AppModel
    struct Row: Identifiable { let id: String; let label: String; let provider: String; var currency: String; var input: String; var output: String }
    @State private var rows: [Row] = []
    @State private var base = "¥"
    @State private var rates: [String: String] = [:]
    @State private var status = ""
    @State private var busy = false
    private let symbols = ["¥", "$", "€", "£", "₩", "₽", "₹"]

    private var usedForeign: [String] {
        Array(Set(rows.filter { !$0.input.isEmpty || !$0.output.isEmpty }.map { $0.currency }.filter { $0 != base && !$0.isEmpty })).sorted()
    }

    var body: some View {
        List {
            Section {
                Text("大多数官方 API 不会通过接口公布价格，所以这里不内置价格表（避免过期的数字）：服务商在模型列表里提供价格的会自动读取，其余请按你实际的账单单价填写（每百万 Token），并给每个模型选货币符号。改价只影响之后的调用。").font(.caption).foregroundStyle(.secondary)
                Picker("统计货币（合计用）", selection: $base) { ForEach(symbols, id: \.self) { Text($0).tag($0) } }
                Button("从服务商读取价格") { Task { await sync() } }.disabled(busy)
            }
            Section("模型（每百万 Token）") {
                if rows.isEmpty { Text("还没有可用的模型，请先添加 AI 接入。").foregroundStyle(.secondary) }
                ForEach($rows) { $r in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(r.label).font(.headline); Text(r.provider).font(.caption2).foregroundStyle(.secondary)
                        HStack {
                            Picker("", selection: $r.currency) { ForEach(symbols, id: \.self) { Text($0).tag($0) } }.labelsHidden().frame(width: 70)
                            TextField("输入", text: $r.input); TextField("输出", text: $r.output)
                        }.textFieldStyle(.roundedBorder)
                    }
                }
            }
            if !usedForeign.isEmpty {
                Section("汇率（费用合计时折算成 \(base)）") {
                    ForEach(usedForeign, id: \.self) { c in
                        HStack { Text("1 \(c) ="); TextField("汇率", text: Binding(get: { rates[c] ?? "" }, set: { rates[c] = $0 })).multilineTextAlignment(.trailing); Text(base) }
                    }
                }
            }
            Section {
                Button(busy ? "请稍候…" : "保存价格") { Task { await save() } }.disabled(busy)
                if !status.isEmpty { Text(status).font(.caption).foregroundStyle(.secondary) }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let d = await model.guarded({ try await model.api.call("GET", "/api/admin/pricing") }) else { return }
        base = text(d["currency"]).isEmpty ? "¥" : text(d["currency"])
        rates = [:]
        for (k, v) in (d.obj("rates") ?? [:]) { rates[k] = number(v) }
        rows = d.list("models").map { m in
            let p = m.obj("price")
            return Row(id: text(m["ref"]), label: text(m["label"]), provider: text(m["providerName"]),
                       currency: (p.flatMap { text($0["currency"]) }).flatMap { $0.isEmpty ? nil : $0 } ?? base,
                       input: p.map { number($0["input"]) } ?? "", output: p.map { number($0["output"]) } ?? "")
        }
    }

    private func save() async {
        busy = true; defer { busy = false }
        var models: JSON = [:]
        for r in rows where !r.input.isEmpty || !r.output.isEmpty {
            models[r.id] = ["input": Double(r.input) ?? 0, "output": Double(r.output) ?? 0, "currency": r.currency] as JSON
        }
        var rt: JSON = [:]
        for c in usedForeign { if let v = Double(rates[c] ?? "") { rt[c] = v } }
        if let out = await model.guarded({ try await model.api.call("PUT", "/api/admin/pricing", json: ["currency": base, "models": models, "rates": rt] as JSON) }) {
            status = "已保存（\(out.int("count")) 个模型有价格），新产生的用量会按新价格计费"
        }
    }

    private func sync() async {
        busy = true; defer { busy = false }
        guard let out = await model.guarded({ try await model.api.call("POST", "/api/admin/pricing/sync", json: [:]) }) else { return }
        let prices = out.obj("prices") ?? [:]
        var n = 0
        for i in rows.indices {
            if let p = prices[rows[i].id] as? JSON { rows[i].input = number(p["input"]); rows[i].output = number(p["output"]); rows[i].currency = text(p["currency"]); n += 1 }
        }
        let report = out.list("report").map { "\(text($0["name"]))：\(text($0["detail"]))" }.joined(separator: "；")
        status = "读到 \(n) 个模型的价格（还没保存，请检查后点“保存价格”）。" + report
    }
}

// MARK: - 站点设置
struct AdminSiteView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @State private var notice = ""
    @State private var personal = false
    @State private var loaded = false
    var body: some View {
        List {
            Section("站点设置") {
                TextField("站点名称", text: $name)
                TextField("登录页公告（可选）", text: $notice, axis: .vertical).lineLimit(2...5)
                Picker("使用模式", selection: $personal) { Text("团队模式").tag(false); Text("个人模式（没有成员管理）").tag(true) }
            }
            Section { Button("保存") { Task { await save() } }.disabled(!loaded) }
        }
        .task {
            if let d = await model.guarded({ try await model.api.call("GET", "/api/site") }) {
                name = text(d["name"]); notice = text(d["notice"]); personal = text(d["mode"]) == "personal"; loaded = true
            }
        }
    }
    private func save() async {
        let body: JSON = ["name": name, "notice": notice, "mode": personal ? "personal" : "team"]
        if await model.guarded({ try await model.api.call("PUT", "/api/admin/site", json: body) }) != nil { model.say("已保存") }
    }
}
