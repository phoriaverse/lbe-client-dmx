import AppKit
import WebKit

final class Launcher: NSObject, NSApplicationDelegate {
    let server = Process()
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 700),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
    let controls = WKWebView()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit SoundSpace DMX", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let item = NSMenuItem()
        item.submenu = appMenu
        menu.addItem(item)
        NSApp.mainMenu = menu

        let bundle = Bundle.main
        let directory = bundle.bundleURL.deletingLastPathComponent()
        var env = ProcessInfo.processInfo.environment
        env["LBE_LIGHTING_RESOURCES"] = bundle.resourceURL!.path
        env["LBE_LAUNCHER_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        // Finder supplies a minimal PATH. The USB serial worker runs in Node.
        env["PATH"] = (env["PATH"] ?? "/usr/bin:/bin") + ":/opt/homebrew/bin:/usr/local/bin"
        let siteConfig = directory.appendingPathComponent("config.pavotube.json")
        if env["LBE_LIGHTING_CONFIG"] == nil && FileManager.default.fileExists(atPath: siteConfig.path) {
            env["LBE_LIGHTING_CONFIG"] = siteConfig.path
        }
        server.environment = env
        server.currentDirectoryURL = directory
        server.executableURL = bundle.executableURL!.deletingLastPathComponent().appendingPathComponent("dmx-server")
        let output = Pipe()
        server.standardOutput = output
        server.terminationHandler = { process in
            DispatchQueue.main.async {
                if process.terminationStatus != 0 {
                    let alert = NSAlert()
                    alert.messageText = "SoundSpace DMX could not keep running"
                    alert.informativeText = "Check that the ENTTEC adapter is connected, Node.js is installed, and another lighting client is not using the adapter or control port."
                    alert.runModal()
                }
                NSApp.terminate(nil)
            }
        }
        do {
            try server.run()
            window.title = "SoundSpace DMX"
            window.isReleasedWhenClosed = false
            window.contentView = controls
            window.center()
            window.makeKeyAndOrderFront(nil)
            // Use the port the helper actually bound, including a site-configured port.
            Task {
                let prefix = "[lighting] control page: http://localhost:"
                for try await line in output.fileHandleForReading.bytes.lines where line.hasPrefix(prefix) {
                    if let port = UInt16(line.dropFirst(prefix.count)),
                       let url = URL(string: "http://127.0.0.1:\(port)/") {
                        controls.load(URLRequest(url: url))
                    }
                }
            }
        } catch {
            NSAlert(error: error).runModal()
            NSApp.terminate(nil)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        server.terminationHandler = nil
        if server.isRunning {
            server.terminate()
            server.waitUntilExit()
        }
    }
}
let app = NSApplication.shared
let launcher = Launcher()
app.delegate = launcher
app.setActivationPolicy(.regular)
app.run()
