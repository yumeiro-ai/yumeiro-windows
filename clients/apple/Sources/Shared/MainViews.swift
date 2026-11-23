import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct MainView: View {
    @EnvironmentObject var model: AppModel
    @State private var visibility: NavigationSplitViewVisibility = .automatic
    @State private var compact: NavigationSplitViewColumn = .detail
    @State private var showSettings = false

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $compact) {
            SidebarView(showSettings: $showSettings, compact: $compact)
                .navigationTitle("Yumeiro")
        } detail: {
            ChatView(compact: $compact)
        }
        .scrollContentBackground(.hidden)
        .sheet(isPresented: $showSettings) { SettingsRoot() }
    }
}

struct SidebarView: View {
    @EnvironmentObject var model: AppModel
    @Binding var showSettings: Bool
    @Binding var compact: NavigationSplitViewColumn
    @State private var deleting: Conv?

    var body: some View {
        List {
            Button { model.newChat(); compact = .detail } label: { Label("新建对话", systemImage: "square.and.pencil") }
            ForEach(model.grouped(), id: \.0) { group in
                Section(group.0) {
                    ForEach(group.1) { conv in
                        Button { Task { await model.openConv(conv.id) }; compact = .detail } label: {
                            Text(conv.title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(conv.id == model.currentId ? Color.primary.opacity(0.1) : Color.clear)
                        .contextMenu { Button("删除", role: .destructive) { deleting = conv } }
                        .swipeActions { Button("删除", role: .destructive) { deleting = conv } }
                    }
                }
            }
            if model.convs.isEmpty { Text("还没有对话").foregroundStyle(.secondary) }
        }
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom) {
            Button { showSettings = true } label: {
                HStack {
                    Circle().fill(accent).frame(width: 36, height: 36).overlay(Text(String((model.me.str("email").first ?? "U")).uppercased()).foregroundColor(.white).bold())
                    VStack(alignment: .leading) {
                        Text(model.me.str("displayName").isEmpty ? model.me.str("email") : model.me.str("displayName")).lineLimit(1)
                        Text(model.usage.isEmpty ? model.session.server : model.usage).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(); Image(systemName: "gearshape").foregroundStyle(.secondary)
                }.padding(10).background(.regularMaterial)
            }.buttonStyle(.plain)
        }
        .confirmationDialog("删除对话", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { conv in
            Button("删除「\(conv.title)」", role: .destructive) { Task { await model.deleteConv(conv.id) } }
        } message: { _ in Text("删不回来。") }
    }
}

struct ChatView: View {
    @EnvironmentObject var model: AppModel
    @Binding var compact: NavigationSplitViewColumn
    @State private var renaming = false
    @State private var draft = ""

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if model.messages.isEmpty {
                    VStack(spacing: 8) {
                        Text("今天想聊点什么？").font(.title2.bold())
                        Text("可以直接提问，也可以点下面的回形针发图片或文件让我读。").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }.padding(.top, 140).padding(.horizontal, 28).frame(maxWidth: .infinity)
                } else {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(model.messages) { m in MessageRow(message: m, streaming: model.busy && m.id == model.messages.last?.id).id(m.id) }
                    }.padding(14)
                }
            }
            .onChange(of: model.messages.last?.content) { _, _ in if let id = model.messages.last?.id { withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(id, anchor: .bottom) } } }
            .onChange(of: model.messages.count) { _, _ in if let id = model.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) { Composer() }
        .navigationTitle(model.title)
        .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { model.newChat() } label: { Label("新对话", systemImage: "square.and.pencil") }
                    if model.currentId != nil {
                        Button { draft = model.title; renaming = true } label: { Label("重命名", systemImage: "pencil") }
                        Button { copyToClipboard(model.transcript()); model.say("已复制整段对话") } label: { Label("复制整段对话", systemImage: "doc.on.doc") }
                        Button(role: .destructive) { if let id = model.currentId { Task { await model.deleteConv(id) } } } label: { Label("删除对话", systemImage: "trash") }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .alert("重命名对话", isPresented: $renaming) {
            TextField("标题", text: $draft)
            Button("确定") { Task { await model.renameConv(draft) } }
            Button("取消", role: .cancel) { }
        }
    }
}

struct MessageRow: View {
    @EnvironmentObject var model: AppModel
    let message: Msg; let streaming: Bool
    var body: some View {
        if message.role == "user" {
            HStack { Spacer(minLength: 40)
                VStack(alignment: .leading, spacing: 8) {
                    Text(message.content).textSelection(.enabled)
                    if !message.atts.isEmpty { AttachmentRow(atts: message.atts) }
                }.padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color.primary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        } else if message.error {
            Text(message.content).foregroundColor(.red)
        } else if message.content.isEmpty && streaming {
            Text("正在思考…").foregroundStyle(.secondary).font(.callout)
        } else { MarkdownView(source: message.content) }
    }
}

struct AttachmentRow: View {
    @EnvironmentObject var model: AppModel
    let atts: [AttRef]
    @State private var viewing: AttRef?
    var body: some View {
        HStack(spacing: 6) {
            ForEach(atts) { att in
                if att.image { AttachmentThumb(att: att).onTapGesture { viewing = att } }
                else {
                    Button { viewing = att } label: {
                        HStack(spacing: 6) {
                            Text((att.name as NSString).pathExtension.uppercased().prefix(5)).font(.system(size: 10, weight: .bold)).padding(.horizontal, 6).padding(.vertical, 2).background(Color.primary.opacity(0.15), in: RoundedRectangle(cornerRadius: 6))
                            Text(att.name).font(.footnote).lineLimit(1)
                        }.padding(8).overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.15)))
                    }.buttonStyle(.plain)
                }
            }
        }
        .sheet(item: $viewing) { att in AttachmentViewer(att: att) }
    }
}

struct AttachmentThumb: View {
    @EnvironmentObject var model: AppModel
    let att: AttRef
    @State private var image: CGImage?
    var body: some View {
        Group {
            if let img = image ?? att.thumb { Image(decorative: img, scale: 1).resizable().scaledToFill() }
            else { Rectangle().fill(Color.primary.opacity(0.1)) }
        }.frame(width: 84, height: 84).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .task { if image == nil, att.thumb == nil, let id = att.attId { image = await model.attachmentImage(id) } }
    }
}

extension AttRef: Equatable { static func == (a: AttRef, b: AttRef) -> Bool { a.id == b.id } }

struct AttachmentViewer: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let att: AttRef
    @State private var text = "正在读取…"
    @State private var image: CGImage?
    var body: some View {
        NavigationStack {
            ScrollView {
                if att.image {
                    if let img = image ?? att.thumb { Image(decorative: img, scale: 1).resizable().scaledToFit().padding() } else { ProgressView().padding() }
                } else { Text(text).font(.system(size: 13, design: .monospaced)).textSelection(.enabled).padding().frame(maxWidth: .infinity, alignment: .leading) }
            }
            .navigationTitle(att.name)
            .iosOnly { $0.navigationBarTitleDisplayMode(.inline) }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("关闭") { dismiss() } }
                if !att.image { ToolbarItem(placement: .cancellationAction) { Button("复制") { copyToClipboard(text); model.say("已复制") } } }
            }
        }
        .frame(minWidth: 320, minHeight: 400)
        .task {
            guard let id = att.attId else { return }
            if att.image { image = await model.attachmentImage(id) } else { text = await model.attachmentText(id) }
        }
    }
}

struct Composer: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""
    @State private var picking = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showModels = false

    var body: some View {
        VStack(spacing: 8) {
            if !model.pending.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 8) { ForEach(model.pending) { PendingChip(item: $0) } } }
            }
            TextField("给 Yumeiro 发消息…", text: $text, axis: .vertical).lineLimit(1...6).textFieldStyle(.plain)
                .onSubmit { sendNow() }
            HStack {
                Menu {
                    Button { showPhotos = true } label: { Label("图片（相册）", systemImage: "photo") }
                    Button { picking = true } label: { Label("文件（PDF、Word、Excel、文本…）", systemImage: "doc") }
                } label: { Image(systemName: "paperclip").font(.title3) }
                Button { showModels = true } label: {
                    HStack(spacing: 4) { Text(model.models.first { $0.ref == model.selectedModel }?.label ?? "选择模型").lineLimit(1); Image(systemName: "chevron.down").font(.caption2) }.font(.footnote).foregroundStyle(.secondary)
                }.buttonStyle(.plain)
                Spacer()
                if model.busy { Button { model.stop() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 30)) }.buttonStyle(.plain) }
                else { Button { sendNow() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)).foregroundStyle(accent) }.buttonStyle(.plain) }
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Color.primary.opacity(0.1)))
        .padding(.horizontal, 10).padding(.bottom, 6)
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 6, matching: .images)
        .onChange(of: photos) { _, items in
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                        model.addFile(name: "photo-\(Int(Date().timeIntervalSince1970)).\(ext)", data: data)
                    }
                }
                photos = []
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                let ok = url.startAccessingSecurityScopedResource(); defer { if ok { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) { model.addFile(name: url.lastPathComponent, data: data) } else { model.say("\(url.lastPathComponent)：读取失败") }
            }
        }
        .sheet(isPresented: $showModels) {
            PickerSheet(title: "选择模型", options: model.models.map { Opt(id: $0.ref, label: $0.label, sub: $0.provider) }, selected: model.selectedModel) { model.chooseModel($0) }
        }
    }

    private func sendNow() {
        let t = text
        if t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.pending.contains(where: { $0.done }) { return }
        model.send(t); text = ""
    }
}

struct PendingChip: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var item: Pending
    var body: some View {
        ZStack(alignment: .topTrailing) {
            HStack(spacing: 6) {
                if item.image, let t = item.thumb { Image(decorative: t, scale: 1).resizable().scaledToFill().frame(width: 56, height: 56).clipped().opacity(item.done ? 1 : 0.6) }
                else { Text((item.name as NSString).pathExtension.uppercased().prefix(5)).font(.system(size: 10, weight: .bold)).padding(.horizontal, 6).padding(.vertical, 2).background(Color.primary.opacity(0.15), in: RoundedRectangle(cornerRadius: 6)).padding(.leading, 8)
                    Text(item.name).font(.caption).lineLimit(1).frame(maxWidth: 140).padding(.trailing, 28) }
            }
            .frame(height: 56).background(Color.primary.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(alignment: .bottom) {
                if !item.done { if item.processing { ProgressView().progressViewStyle(.linear).tint(accent) } else { ProgressView(value: Double(item.pct), total: 100).tint(accent) } }
            }
            .overlay { if !item.done { Text(item.processing ? "解析中…" : "\(item.pct)%").font(.caption2.bold()) } }
            Button { model.removePending(item) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.6)) }.buttonStyle(.plain).padding(3)
        }
    }
}
