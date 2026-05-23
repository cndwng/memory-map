// Memory Map — native Cocoa launcher.
//
// Owns a single Dock tile with the app's icon. Starts the localhost HTTP
// server (server.py) as a child process at launch, then opens a WKWebView
// window pointed at it. Dock-icon clicks while running focus the existing
// window. Popup requests from the page (cmd+click on a row) open additional
// WKWebView windows owned by this same app.
//
// Compile:
//   swiftc -O MemoryMap.swift -o ../MacOS/MemoryMap

import Cocoa
import WebKit

// MARK: - Window controller

final class MemoryMapWindowController: NSWindowController, WKUIDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var webView: WKWebView!
    weak var appDelegate: AppDelegate?

    convenience init(url: URL, isPopup: Bool, appDelegate: AppDelegate) {
        let size = isPopup ? NSSize(width: 780, height: 900) : NSSize(width: 1200, height: 820)
        let rect = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Memory Map"
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.center()
        self.init(window: window)
        self.appDelegate = appDelegate

        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()
        userContent.add(self, name: "openPopup")
        config.userContentController = userContent
        // Allow access to localhost over plain http.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        // Set a recognizable user agent fragment so the JS can detect WKWebView.
        webView.customUserAgent = "MemoryMap/1.0 (WKWebView)"
        window.contentView?.addSubview(webView)

        webView.load(URLRequest(url: url))
    }

    // window.open or target=_blank — open in a new MemoryMap window instead
    // of failing silently.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            appDelegate?.openPopupWindow(url: url)
        }
        return nil
    }

    // JS → Swift message bridge: page can post {path: "..."} to open a popup.
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if message.name == "openPopup",
           let body = message.body as? [String: Any],
           let path = body["path"] as? String {
            appDelegate?.openPopupForPath(path)
        }
    }

    override func windowWillLoad() { super.windowWillLoad() }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    var serverProcess: Process?
    var port: Int?
    var mainWindowController: MemoryMapWindowController?
    var popupControllers: [MemoryMapWindowController] = []

    let bundlePath = Bundle.main.bundlePath  // .../MemoryMap.app
    var resourcesDir: String { bundlePath + "/Contents/Resources" }
    var serverScript: String { resourcesDir + "/server.py" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        guard let port = self.port else {
            showFatalAlert("Memory Map: server failed to start. Check ~/Library/Application Support/MemoryMap/server.log.")
            return
        }
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        openMainWindow(url: url)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let mw = mainWindowController, let window = mw.window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else if let port = self.port {
            let url = URL(string: "http://127.0.0.1:\(port)/")!
            openMainWindow(url: url)
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Quit when the main window is closed (so the Dock tile goes away).
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }

    // MARK: server

    private func startServer() {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["python3", serverScript]

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        do {
            try proc.run()
        } catch {
            NSLog("Memory Map: failed to start server: \(error)")
            return
        }
        self.serverProcess = proc

        // Wait briefly for the server to print its port on the first stdout line.
        let handle = outPipe.fileHandleForReading
        var collected = Data()
        let deadline = Date().addingTimeInterval(5.0)
        while Date() < deadline {
            let chunk = handle.availableData
            if !chunk.isEmpty {
                collected.append(chunk)
                if let s = String(data: collected, encoding: .utf8), s.contains("\n") { break }
            } else {
                Thread.sleep(forTimeInterval: 0.05)
            }
        }
        if let s = String(data: collected, encoding: .utf8),
           let first = s.split(separator: "\n").first,
           let p = Int(first.trimmingCharacters(in: .whitespacesAndNewlines)) {
            self.port = p
        }

        // Drain the rest of stdout/stderr in the background so the pipes don't block.
        outPipe.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        errPipe.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
    }

    // MARK: windows

    private func openMainWindow(url: URL) {
        let wc = MemoryMapWindowController(url: url, isPopup: false, appDelegate: self)
        self.mainWindowController = wc
        wc.window?.delegate = self
        wc.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func openPopupForPath(_ path: String) {
        guard let port = self.port else { return }
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard let url = URL(string: "http://127.0.0.1:\(port)/?focus=1&path=\(encoded)") else { return }
        openPopupWindow(url: url)
    }

    func openPopupWindow(url: URL) {
        let wc = MemoryMapWindowController(url: url, isPopup: true, appDelegate: self)
        wc.window?.delegate = self
        popupControllers.append(wc)
        wc.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: helpers

    private func showFatalAlert(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Memory Map"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }
}

extension AppDelegate: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow else { return }
        if closing === mainWindowController?.window {
            mainWindowController = nil
        } else {
            popupControllers.removeAll { $0.window === closing }
        }
    }
}

// MARK: - Entry point

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
