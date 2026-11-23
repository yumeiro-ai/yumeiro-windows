import SwiftUI

@main
struct YumeiroApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                #if os(macOS)
                .frame(minWidth: 820, minHeight: 560)
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 760)
        #endif
    }
}
