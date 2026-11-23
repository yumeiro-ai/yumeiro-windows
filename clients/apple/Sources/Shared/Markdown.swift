import SwiftUI

enum Block {
    case para(String), heading(Int, String), bullet(String, String, Int), quote(String), code(String, String), rule
}

/// 很小的 Markdown 解析：标题、列表、引用、代码块、分隔线、段落。
func parseBlocks(_ source: String) -> [Block] {
    var out: [Block] = []
    let lines = source.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n")
    var i = 0; var para = ""
    func flush() { if !para.isEmpty { out.append(.para(para.trimmingCharacters(in: .whitespaces))); para = "" } }
    func matches(_ pattern: String, _ s: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }
    while i < lines.count {
        let line = lines[i]; let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("```") {
            flush(); let lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces); var code: [String] = []; i += 1
            while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(lines[i]); i += 1 }
            out.append(.code(lang, code.joined(separator: "\n")))
        } else if t.isEmpty { flush() }
        else if matches("^#{1,3}\\s+.*", t) { flush(); let n = t.prefix { $0 == "#" }.count; out.append(.heading(n, String(t.dropFirst(n)).trimmingCharacters(in: .whitespaces))) }
        else if matches("^(-{3,}|\\*{3,}|_{3,})$", t) { flush(); out.append(.rule) }
        else if t.hasPrefix(">") { flush(); out.append(.quote(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))) }
        else if matches("^([-*+]|[0-9]+[.)])\\s+.*", t) {
            flush(); let marker = String(t.prefix { !$0.isWhitespace }); let indent = (line.count - line.drop(while: { $0 == " " }).count) / 2
            out.append(.bullet(marker.first?.isNumber == true ? marker : "•", String(t.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces), indent))
        } else { if !para.isEmpty { para += "\n" }; para += line }
        i += 1
    }
    flush(); return out
}

func inlineText(_ s: String) -> Text {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    if let a = try? AttributedString(markdown: s, options: options) { return Text(a) }
    return Text(s)
}

struct MarkdownView: View {
    let source: String
    var body: some View {
        let blocks = parseBlocks(source)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .para(let t): inlineText(t).lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading)
                case .heading(let n, let t): inlineText(t).font(n == 1 ? .title2.bold() : n == 2 ? .title3.bold() : .headline).padding(.top, 4).frame(maxWidth: .infinity, alignment: .leading)
                case .bullet(let m, let t, let indent): HStack(alignment: .firstTextBaseline, spacing: 8) { Text(m).foregroundStyle(.secondary); inlineText(t).lineSpacing(4) }.padding(.leading, CGFloat(indent) * 14).frame(maxWidth: .infinity, alignment: .leading)
                case .quote(let t): HStack(spacing: 6) { Rectangle().fill(accent).frame(width: 3); inlineText(t).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading)
                case .code(let lang, let code): CodeBlock(lang: lang, code: code)
                case .rule: Divider()
                }
            }
        }.textSelection(.enabled)
    }
}

struct CodeBlock: View {
    let lang: String; let code: String
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { Text(lang.isEmpty ? "代码" : lang).font(.caption).foregroundStyle(.secondary); Spacer()
                Button(copied ? "已复制" : "复制") { copyToClipboard(code); copied = true }.font(.caption).buttonStyle(.plain).foregroundStyle(.secondary) }
                .padding(.horizontal, 12).padding(.top, 8)
            ScrollView(.horizontal, showsIndicators: false) { Text(code).font(.system(size: 12.5, design: .monospaced)).padding(12).textSelection(.enabled) }
        }
        .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .foregroundColor(Color(hex: 0xE6E8EF))
    }
}
