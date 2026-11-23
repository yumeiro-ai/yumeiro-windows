import Foundation
import Security

struct ApiError: Error, LocalizedError {
    var message: String
    var status: Int = 0
    var errorDescription: String? { message }
}

let httpsUnsupported = "这个地址不支持 HTTPS"

/// 服务器地址、账号、会话 Cookie 和 CSRF 令牌。Cookie 和令牌放在钥匙串里，其余放 UserDefaults。
final class Session: @unchecked Sendable {
    private let lock = NSLock()
    private let defaults = UserDefaults.standard
    var server: String { get { defaults.string(forKey: "server") ?? "" } set { defaults.set(newValue, forKey: "server") } }
    var email: String { get { defaults.string(forKey: "email") ?? "" } set { defaults.set(newValue, forKey: "email") } }
    var ignoreCert: Bool { get { defaults.bool(forKey: "ignoreCert") } set { defaults.set(newValue, forKey: "ignoreCert") } }
    var defaultModel: String { get { defaults.string(forKey: "defaultModel") ?? "" } set { defaults.set(newValue, forKey: "defaultModel") } }
    var themeMode: String { get { defaults.string(forKey: "themeMode") ?? "dark" } set { defaults.set(newValue, forKey: "themeMode") } }
    var fontScale: Double { get { let v = defaults.double(forKey: "fontScale"); return v == 0 ? 1.0 : v } set { defaults.set(newValue, forKey: "fontScale") } }

    /// 壁纸只属于这台设备：不跟服务器、账号走，切换服务器或账号后仍然保留。
    /// "" = 无；"local" = 本机图片（文件在 Application Support）；"preset:xxx" = 内置渐变；"server:文件名" = 服务器壁纸库里的某张（只记名字）
    var wallpaperChoice: String { get { defaults.string(forKey: "deviceWallpaper") ?? "" } set { defaults.set(newValue, forKey: "deviceWallpaper") } }
    var wallpaperDim: Int { get { (defaults.object(forKey: "deviceWallpaperDim") as? Int) ?? 35 } set { defaults.set(newValue, forKey: "deviceWallpaperDim") } }

    private var _cookies: [String: String] = [:]
    private var _csrf = ""
    init() {
        if let raw = Keychain.read("cookies"), let data = raw.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] { _cookies = obj }
        _csrf = Keychain.read("csrf") ?? ""
    }
    var cookies: [String: String] { lock.lock(); defer { lock.unlock() }; return _cookies }
    var csrf: String {
        get { lock.lock(); defer { lock.unlock() }; return _csrf }
        set { lock.lock(); _csrf = newValue; lock.unlock(); Keychain.write("csrf", newValue) }
    }
    func setCookie(_ name: String, _ value: String?) {
        lock.lock()
        if let value = value, !value.isEmpty { _cookies[name] = value } else { _cookies.removeValue(forKey: name) }
        let snapshot = _cookies
        lock.unlock()
        if let data = try? JSONSerialization.data(withJSONObject: snapshot), let text = String(data: data, encoding: .utf8) { Keychain.write("cookies", text) }
    }
    var hasLogin: Bool { !cookies.isEmpty }
    func clearLogin() {
        lock.lock(); _cookies = [:]; _csrf = ""; lock.unlock()
        Keychain.write("cookies", ""); Keychain.write("csrf", "")
    }
}

enum Keychain {
    private static let service = "org.yumeiro.app"
    static func read(_ key: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func write(_ key: String, _ value: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var add = base; add[kSecValueData as String] = data
        SecItemAdd(add as CFDictionary, nil)
    }
}

func normalizeServer(_ input: String) -> String {
    var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
    while s.hasSuffix("/") { s.removeLast() }
    if s.isEmpty { return "" }
    let lower = s.lowercased()
    if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") { s = "https://" + s }
    return s
}

typealias JSON = [String: Any]

final class ApiClient: NSObject, URLSessionDelegate, @unchecked Sendable {
    let session: Session
    init(session: Session) { self.session = session }

    private lazy var http: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 3600
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    // 只在用户明确勾选“忽略证书错误”并且只针对已保存的这个服务器时放行（自签名证书）
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if self.session.ignoreCert, challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           challenge.protectionSpace.host == URL(string: self.session.server)?.host, let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    private func makeRequest(_ method: String, _ path: String, body: Data? = nil, contentType: String? = nil, timeout: TimeInterval = 60) throws -> URLRequest {
        guard let url = URL(string: session.server + path) else { throw ApiError(message: "服务器地址不对") }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(session.server, forHTTPHeaderField: "Origin")
        req.setValue("Yumeiro-Apple/0.46", forHTTPHeaderField: "User-Agent")
        let cookies = session.cookies
        if !cookies.isEmpty { req.setValue(cookies.map { "\($0.key)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie") }
        if method != "GET", !session.csrf.isEmpty { req.setValue(session.csrf, forHTTPHeaderField: "X-CSRF-Token") }
        if let body = body { req.httpBody = body; req.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type") }
        return req
    }

    private func remember(_ response: URLResponse?) {
        guard let http = response as? HTTPURLResponse, let url = http.url else { return }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields { if let k = k as? String, let v = v as? String { headers[k] = v } }
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: headers, for: url) {
            let expired = cookie.expiresDate.map { $0 < Date() } ?? false
            session.setCookie(cookie.name, (expired || cookie.value.isEmpty) ? nil : cookie.value)
        }
    }

    func explain(_ error: Error) -> String {
        if let e = error as? ApiError { return e.message }
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return error.localizedDescription }
        switch ns.code {
        case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid, NSURLErrorClientCertificateRejected:
            return "服务器的证书不被信任（自签名证书常见）。确认是自己的服务器后，在登录页勾选“忽略证书错误”。"
        case NSURLErrorSecureConnectionFailed: return "\(httpsUnsupported)。如果服务器是 http 的，请在地址前面写上 http://"
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return "找不到这个服务器地址，请检查网址和网络。"
        case NSURLErrorTimedOut: return "连接超时，请检查网络或稍后再试。"
        case NSURLErrorCannotConnectToHost: return "连不上服务器，请检查地址、端口和网络。"
        case NSURLErrorNotConnectedToInternet: return "没有网络连接。"
        case NSURLErrorCancelled: return "已取消"
        default: return error.localizedDescription
        }
    }

    func request(_ method: String, _ path: String, json: JSON? = nil, timeout: TimeInterval = 60) async throws -> (status: Int, data: Data) {
        let body = try json.map { try JSONSerialization.data(withJSONObject: $0) }
        let req = try makeRequest(method, path, body: body, timeout: timeout)
        do {
            let (data, response) = try await http.data(for: req)
            remember(response)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
        } catch { throw ApiError(message: explain(error)) }
    }

    static func parse(_ data: Data) -> JSON { ((try? JSONSerialization.jsonObject(with: data)) as? JSON) ?? [:] }

    /// 需要登录的接口：401 抛出带 status 的错误，让界面回到登录页。
    @discardableResult
    func call(_ method: String, _ path: String, json: JSON? = nil) async throws -> JSON {
        let (status, data) = try await request(method, path, json: json)
        let obj = ApiClient.parse(data)
        if status == 401 { throw ApiError(message: "登录已过期，请重新登录", status: 401) }
        if !(200...299).contains(status) { throw ApiError(message: (obj["error"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "请求失败（HTTP \(status)）", status: status) }
        return obj
    }

    func login(email: String, password: String) async throws -> JSON {
        let (status, data) = try await request("POST", "/api/auth/login", json: ["email": email, "password": password])
        let obj = ApiClient.parse(data)
        if (200...299).contains(status), obj["authenticated"] as? Bool == true {
            session.csrf = obj["csrfToken"] as? String ?? ""
            return obj
        }
        throw ApiError(message: (obj["error"] as? String) ?? "登录失败（HTTP \(status)）", status: status)
    }

    func checkSession() async throws -> JSON? {
        let (status, data) = try await request("GET", "/api/auth/session", timeout: 15)
        let obj = ApiClient.parse(data)
        if (200...299).contains(status), obj["authenticated"] as? Bool == true {
            if let token = obj["csrfToken"] as? String { session.csrf = token }
            return obj
        }
        return nil
    }

    func logout() async { _ = try? await request("POST", "/api/auth/logout", json: [:]); session.clearLogin() }

    func bytes(_ path: String, maxBytes: Int = 12 * 1024 * 1024) async throws -> (type: String, data: Data) {
        var req = try makeRequest("GET", path, timeout: 60)
        req.setValue("*/*", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await http.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if !(200...299).contains(status) { throw ApiError(message: "读取失败（HTTP \(status)）", status: status) }
            if data.count > maxBytes { throw ApiError(message: "文件太大") }
            return ((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "", data)
        } catch let e as ApiError { throw e } catch { throw ApiError(message: explain(error)) }
    }

    /// 流式聊天（SSE）：以异步序列的形式一个个给出事件（event, data）。取消消费它的 Task 即可中断。
    func events(_ path: String, json: JSON) -> AsyncThrowingStream<(String, JSON), Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body = try JSONSerialization.data(withJSONObject: json)
                    var req = try self.makeRequest("POST", path, body: body, timeout: 600)
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await self.http.bytes(for: req)
                    self.remember(response)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    if !(200...299).contains(status) {
                        var text = Data(); for try await b in bytes { text.append(b) }
                        let msg = (ApiClient.parse(text)["error"] as? String) ?? ""
                        if status == 401 { throw ApiError(message: "登录已过期，请重新登录", status: 401) }
                        throw ApiError(message: msg.isEmpty ? "请求失败（HTTP \(status)）" : msg, status: status)
                    }
                    // AsyncBytes.lines 会跳过空行，所以不靠空行分隔：每个 data 行就是一个完整事件
                    var event = "message"
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") { event = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
                        else if line.hasPrefix("data:") {
                            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                            continuation.yield((event, ApiClient.parse(Data(payload.utf8)))); event = "message"
                        }
                    }
                    continuation.finish()
                } catch let e as ApiError { continuation.finish(throwing: e) }
                catch is CancellationError { continuation.finish() }
                catch { (error as NSError).code == NSURLErrorCancelled ? continuation.finish() : continuation.finish(throwing: ApiError(message: self.explain(error))) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    final class ProgressDelegate: NSObject, URLSessionTaskDelegate {
        let onProgress: (Int64, Int64) -> Void
        init(_ f: @escaping (Int64, Int64) -> Void) { onProgress = f }
        func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) { onProgress(totalBytesSent, totalBytesExpectedToSend) }
    }

    /// 上传附件（带进度；取消请取消调用它的 Task）。
    func upload(name: String, data: Data, onProgress: @escaping (Int64, Int64) -> Void) async throws -> JSON {
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "file"
        let req = try makeRequest("PUT", "/api/attachments?name=\(encoded)", body: nil, timeout: 600)
        var r = req; r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        do {
            let (respData, response) = try await http.upload(for: r, from: data, delegate: ProgressDelegate(onProgress))
            remember(response)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let obj = ApiClient.parse(respData)
            if status == 401 { throw ApiError(message: "登录已过期，请重新登录", status: 401) }
            if !(200...299).contains(status) { throw ApiError(message: (obj["error"] as? String) ?? "上传失败（HTTP \(status)）", status: status) }
            guard let att = obj["attachment"] as? JSON else { throw ApiError(message: "服务器没有返回附件信息") }
            return att
        } catch let e as ApiError { throw e } catch { throw ApiError(message: explain(error)) }
    }
}

extension Dictionary where Key == String, Value == Any {
    func str(_ key: String) -> String { (self[key] as? String) ?? "" }
    func int(_ key: String) -> Int { (self[key] as? Int) ?? Int((self[key] as? Double) ?? 0) }
    func bool(_ key: String, _ def: Bool = false) -> Bool { (self[key] as? Bool) ?? def }
    func list(_ key: String) -> [JSON] { (self[key] as? [JSON]) ?? [] }
    func obj(_ key: String) -> JSON? { self[key] as? JSON }
}
