import SwiftUI

struct WorkspaceView: View {
    @EnvironmentObject var model: AppModel
    @State private var search = ""
    @State private var results: [WorkspaceMember] = []
    @State private var searching = false

    private var active: Workspace? { model.activeWorkspace }
    private var canManage: Bool { active?.mine == true || model.isAdmin }

    var body: some View {
        Form {
            Section("工作区") {
                if model.workspaces.isEmpty {
                    Text("还没有可访问的工作区").foregroundStyle(.secondary)
                } else {
                    ForEach(model.workspaces) { workspace in
                        Button {
                            model.activeWorkspace = workspace
                            results = []
                            search = ""
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(workspace.name)
                                    Text(workspace.owner.isEmpty ? "工作区" : workspace.owner)
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if workspace.id == active?.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }.buttonStyle(.plain)
                    }
                }
            }
            if let workspace = active {
                Section("成员") {
                    if workspace.members.isEmpty {
                        Text("暂无成员").foregroundStyle(.secondary)
                    } else {
                        ForEach(workspace.members) { member in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.name)
                                    Text(member.email).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if canManage && member.id != workspace.owner {
                                    Button("移除", role: .destructive) {
                                        Task { _ = await model.removeWorkspaceMember(workspace.id, userId: member.id) }
                                    }
                                }
                            }
                        }
                    }
                }
                if canManage {
                    Section("邀请成员") {
                        HStack {
                            TextField("按邮箱或姓名搜索", text: $search)
                            Button(searching ? "搜索中…" : "搜索") {
                                Task {
                                    searching = true
                                    results = await model.searchWorkspaceMembers(workspace.id, query: search)
                                    searching = false
                                }
                            }.disabled(search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || searching)
                        }
                        ForEach(results) { member in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(member.name)
                                    Text(member.email).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("邀请") {
                                    Task {
                                        if await model.addWorkspaceMember(workspace.id, userId: member.id) {
                                            results.removeAll { $0.id == member.id }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("工作区")
        .task { await model.loadWorkspaces() }
    }
}
