import Foundation
import SwiftUI
import ImageIO

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

func copyToClipboard(_ text: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = text
    #elseif canImport(AppKit)
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    #endif
}

/// 用 ImageIO 生成缩略图（iOS 和 macOS 通用，不依赖 UIImage / NSImage）
func makeThumbnail(_ data: Data, maxSize: Int = 1600) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maxSize]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
}

struct Conv: Identifiable, Hashable { let id: String; var title: String; var updatedAt: Double }
struct ModelOpt: Identifiable, Hashable { let ref: String; let label: String; let provider: String; var id: String { ref } }
struct AttRef: Identifiable { let id = UUID(); let attId: String?; let name: String; let image: Bool; var thumb: CGImage? = nil }
struct Msg: Identifiable { let id: Int; var role: String; var content: String; var atts: [AttRef] = []; var error = false }
struct MemoryItem: Identifiable { let id: String; let text: String; let pinned: Bool }
struct AgentOpt: Identifiable, Hashable { let id: String; let name: String; let description: String; let mine: Bool; var systemPrompt = ""; var model = ""; var skillIds: [String] = []; var shared = false }
struct SkillItem: Identifiable, Hashable { let id: String; let title: String; let description: String; let content: String; let shared: Bool; let mine: Bool }
struct MarketItem: Identifiable, Hashable { var id: String { key }; let key: String; let type: String; let title: String; let description: String; let author: String; var installed: Bool }
struct Member: Identifiable, Hashable { let id: String; let email: String; let name: String; let disabled: Bool; let todayCalls: Int; let monthCalls: Int; let tokens: Int }
struct WorkspaceMember: Identifiable, Hashable {
    let id: String
    let email: String
    let name: String
    let disabled: Bool
}
struct Workspace: Identifiable, Hashable {
    let id: String
    let name: String
    let createdAt: Double
    let mine: Bool
    let owner: String
    var members: [WorkspaceMember]
}
struct McpItem: Identifiable { var id: String { name }; let name: String; let command: String; let enabled: Bool }
struct Approval: Identifiable { var id: String { code }; let code: String; let ip: String; let ua: String; let expiresAt: Double }
struct WallItem: Identifiable, Hashable { var id: String { name }; let name: String; let kind: String }
struct Opt: Identifiable, Hashable { let id: String; let label: String; var sub = "" }

struct WallPreset { let id: String; let label: String; let colors: [Color] }
let wallPresets: [WallPreset] = [
    WallPreset(id: "aurora", label: "极光", colors: [Color(hex: 0x1D2B64), Color(hex: 0xF8CDDA)]),
    WallPreset(id: "dusk", label: "黄昏", colors: [Color(hex: 0x355C7D), Color(hex: 0x6C5B7B), Color(hex: 0xC06C84)]),
    WallPreset(id: "mint", label: "薄荷", colors: [Color(hex: 0xA8EDEA), Color(hex: 0xFED6E3)]),
    WallPreset(id: "ocean", label: "海湾", colors: [Color(hex: 0x2193B0), Color(hex: 0x6DD5ED)]),
    WallPreset(id: "sunrise", label: "日出", colors: [Color(hex: 0xFF9A9E), Color(hex: 0xFECFEF)]),
    WallPreset(id: "forest", label: "森林", colors: [Color(hex: 0x134E5E), Color(hex: 0x71B280)]),
    WallPreset(id: "night", label: "夜空", colors: [Color(hex: 0x0F2027), Color(hex: 0x203A43), Color(hex: 0x2C5364)]),
    WallPreset(id: "sand", label: "沙丘", colors: [Color(hex: 0xF6D365), Color(hex: 0xFDA085)])
]

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
}

/// 待发送的附件：上传进度、取消都在这里。
@MainActor
final class Pending: ObservableObject, Identifiable {
    let id = UUID()
    let name: String; let image: Bool; let thumb: CGImage?
    @Published var attId = ""
    @Published var pct = 0
    @Published var processing = false
    var task: Task<Void, Never>?
    var cancelled = false
    var done: Bool { !attId.isEmpty }
    init(name: String, image: Bool, thumb: CGImage?) { self.name = name; self.image = image; self.thumb = thumb }
}

enum Screen { case loading, login, chat }
enum Page: Hashable { case settings, agents, skills, market, admin, security, workspace }
