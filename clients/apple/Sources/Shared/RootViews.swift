import SwiftUI

let accent = Color(hex: 0xE95164)

extension View {
    @ViewBuilder func iosOnly<T: View>(_ transform: (Self) -> T) -> some View {
        #if os(iOS)
        transform(self)
        #else
        self
        #endif
    }
    /// 磨砂玻璃卡片
    func glassCard(_ radius: CGFloat = 16) -> some View {
        self.padding(14).background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Color.primary.opacity(0.08)))
    }
}

func dynamicSize(_ scale: Double) -> DynamicTypeSize {
    switch scale { case ..<0.95: return .small; case ..<1.05: return .large; case ..<1.2: return .xLarge; default: return .xxLarge }
}

/// 壁纸（图片或渐变）+ 遮罩；没有壁纸时是纯色背景
struct BackgroundView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.colorScheme) var scheme
    var body: some View {
        ZStack {
            Rectangle().fill(scheme == .dark ? Color(hex: 0x0F1117) : Color(hex: 0xF4F5FA))
            if let img = model.wallImage {
                Image(decorative: img, scale: 1).resizable().scaledToFill()
            } else if let colors = model.wallGradient {
                LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
            }
            if model.wallImage != nil || model.wallGradient != nil {
                let alpha = min(0.9, 0.15 + Double(max(0, min(80, model.wallDim))) / 100 * 0.75)
                Rectangle().fill((scheme == .dark ? Color.black : Color.white).opacity(alpha))
            }
        }
        .ignoresSafeArea()
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel
    var scheme: ColorScheme? { switch model.themeMode { case "light": return .light; case "system": return nil; default: return .dark } }

    var body: some View {
        ZStack {
            BackgroundView()
            switch model.screen {
            case .loading: ProgressView("正在连接…")
            case .login: LoginView()
            case .chat: MainView()
            }
            if !model.toast.isEmpty {
                VStack { Spacer(); Text(model.toast).font(.callout).padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.thickMaterial, in: Capsule()).padding(.bottom, 90).transition(.opacity) }
                    .task(id: model.toast) { try? await Task.sleep(nanoseconds: 3_200_000_000); model.toast = "" }
                    .allowsHitTesting(false)
            }
        }
        .tint(accent)
        .preferredColorScheme(scheme)
        .dynamicTypeSize(dynamicSize(model.fontScale))
        .animation(.easeOut(duration: 0.2), value: model.toast)
    }
}

struct LoginView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                RoundedRectangle(cornerRadius: 20, style: .continuous).fill(LinearGradient(colors: [accent, Color(hex: 0xB63A8C)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 64, height: 64).overlay(Text("Y").font(.system(size: 30, weight: .bold)).foregroundColor(.white)).padding(.top, 60)
                Text("Yumeiro").font(.title.bold())
                Text("登录你的私有工作空间").foregroundStyle(.secondary).font(.subheadline)
                VStack(spacing: 10) {
                    TextField("服务器地址（如 https://你的域名）", text: $model.serverInput).textFieldStyle(.roundedBorder)
                        .iosOnly { $0.textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL) }
                    TextField("邮箱", text: $model.emailInput).textFieldStyle(.roundedBorder)
                        .iosOnly { $0.textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress) }
                    SecureField("密码", text: $model.passwordInput).textFieldStyle(.roundedBorder).onSubmit { Task { await model.login() } }
                    Toggle(isOn: $model.ignoreCertInput) { VStack(alignment: .leading) { Text("忽略证书错误"); Text("服务器用自签名证书时才勾选").font(.caption).foregroundStyle(.secondary) } }
                    if !model.loginError.isEmpty { Text(model.loginError).font(.footnote).foregroundColor(.red).frame(maxWidth: .infinity, alignment: .leading) }
                    Button { Task { await model.login() } } label: { Text(model.loginBusy ? "登录中…" : "登录").frame(maxWidth: .infinity).padding(.vertical, 6) }
                        .buttonStyle(.borderedProminent).disabled(model.loginBusy)
                }.glassCard(20).frame(maxWidth: 440)
                Text("账号由团队管理员创建。管理员请用网页版的 /admin 入口登录管理后台。").font(.caption).foregroundStyle(.secondary).frame(maxWidth: 440, alignment: .leading)
            }.padding(24).frame(maxWidth: .infinity)
        }
    }
}
