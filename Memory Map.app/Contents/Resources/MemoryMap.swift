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
        // Disable the macOS "Show Tab Bar" / window-tab merging UI — it
        // doesn't make sense for our app and adds a useless View-menu item.
        window.tabbingMode = .disallowed
        window.center()
        self.init(window: window)
        self.appDelegate = appDelegate

        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()
        userContent.add(self, name: "openPopup")
        userContent.add(self, name: "downloadFile")
        config.userContentController = userContent
        // Allow access to localhost over plain http.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        // Stop WKWebView from painting a stark white background before the
        // page renders. We let the underlying NSWindow show through, which
        // tracks the system appearance (dark in dark mode). Combined with
        // template.html's <meta color-scheme> + html { background } rule,
        // this kills the white flash on dark-mode launch.
        webView.setValue(false, forKey: "drawsBackground")
        window.backgroundColor = NSColor.windowBackgroundColor
        // Two-finger pinch on trackpad to zoom — orthogonal to the CSS-zoom
        // that ⌘+/⌘-/⌘0 drive in app.js.
        webView.allowsMagnification = true
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
            // External links open in the user's default browser, not in a
            // popup MemoryMap window.
            if isExternalURL(url) {
                NSWorkspace.shared.open(url)
            } else {
                appDelegate?.openPopupWindow(url: url)
            }
        }
        return nil
    }

    // Intercept link clicks. Internal nav (localhost) stays in the webview;
    // external (http/https to anywhere else) opens in the default browser.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           isExternalURL(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    private func isExternalURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "http" || scheme == "https" {
            // localhost / 127.0.0.1 is our own server — those stay internal.
            if let host = url.host, host == "127.0.0.1" || host == "localhost" {
                return false
            }
            return true
        }
        if scheme == "mailto" || scheme == "tel" { return true }
        return false
    }

    // JS → Swift message bridge.
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if message.name == "openPopup",
           let body = message.body as? [String: Any],
           let path = body["path"] as? String {
            appDelegate?.openPopupForPath(path)
        } else if message.name == "downloadFile",
                  let body = message.body as? [String: Any],
                  let filename = body["filename"] as? String,
                  let content = body["content"] as? String {
            saveDownload(filename: filename, content: content)
        }
    }

    private func saveDownload(filename: String, content: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        panel.canCreateDirectories = true
        panel.allowedContentTypes = []  // accept whatever filename has
        panel.title = "Save File"
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory,
                                                     in: .userDomainMask).first
        panel.beginSheetModal(for: self.window!) { result in
            guard result == .OK, let url = panel.url else { return }
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
            } catch {
                NSLog("Memory Map: failed to write download: \(error)")
            }
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
    var viewerControllers: [MemoryMapWindowController] = []
    // Set by application(_:open:) to cancel the deferred default-window open.
    private var didOpenLaunchWindow = false
    // Files that arrived before the server was ready; drained once port is set.
    private var pendingFileOpens: [String] = []

    let bundlePath = Bundle.main.bundlePath  // .../Memory Map.app
    var resourcesDir: String { bundlePath + "/Contents/Resources" }
    var serverScript: String { resourcesDir + "/server.py" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setUpMenuBar()
        startServer()
        guard self.port != nil else {
            showFatalAlert("Memory Map: server failed to start. Check ~/Library/Application Support/MemoryMap/server.log.")
            return
        }
        // Rebuild the data file if this is a fresh install or a new version
        // (the data shape can change between releases, so a stale JSON could
        // break the viewer). No-op on repeat launches of the same version.
        buildIfNeeded()
        // Defer the default-window open. If macOS is going to fire
        // application(_:open:) with a file URL for a file-association launch,
        // that handler will set didOpenLaunchWindow and we'll skip here.
        // Otherwise (plain launch — Dock click, ⌘-space), this fires and opens
        // the main app (or welcome on first run).
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self = self, !self.didOpenLaunchWindow else { return }
            guard let port = self.port else { return }
            let path = self.welcomeCompleted() ? "/" : "/welcome"
            self.openMainWindow(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
            self.didOpenLaunchWindow = true
        }
    }

    // MARK: first-launch + version tracking

    private var dataDir: String {
        ("~/Library/Application Support/MemoryMap" as NSString).expandingTildeInPath
    }

    private func currentVersion() -> String {
        return Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    private func lastBuiltVersion() -> String? {
        let path = (dataDir as NSString).appendingPathComponent("last-built-version.txt")
        guard let s = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func writeLastBuiltVersion(_ v: String) {
        try? FileManager.default.createDirectory(atPath: dataDir,
                                                 withIntermediateDirectories: true)
        let path = (dataDir as NSString).appendingPathComponent("last-built-version.txt")
        try? v.write(toFile: path, atomically: true, encoding: .utf8)
    }

    private func welcomeCompleted() -> Bool {
        let path = (dataDir as NSString).appendingPathComponent("welcome-completed.txt")
        return FileManager.default.fileExists(atPath: path)
    }

    private func buildIfNeeded() {
        let dataFile = (dataDir as NSString).appendingPathComponent("memory-map.json")
        let dataMissing = !FileManager.default.fileExists(atPath: dataFile)
        let cur = currentVersion()
        let last = lastBuiltVersion()
        if !dataMissing && cur == last {
            return  // Same version, data exists → trust it.
        }
        try? FileManager.default.createDirectory(atPath: dataDir,
                                                 withIntermediateDirectories: true)
        // Synchronous build. Typically <1 second on a normal ~/.claude setup.
        let buildScript = (resourcesDir as NSString).appendingPathComponent("build.py")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["python3", buildScript]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            writeLastBuiltVersion(cur)
        } catch {
            NSLog("Memory Map: build on launch failed: \(error)")
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        handleFileURLs(urls.map { $0.path })
    }

    // Legacy single-file API. Implemented as a backup — some macOS versions /
    // launch paths dispatch via this instead of the modern array-based one.
    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        handleFileURLs([filename])
        return true
    }

    private func handleFileURLs(_ paths: [String]) {
        // Cancel the deferred default-window open — we're handling the launch.
        didOpenLaunchWindow = true
        for path in paths {
            openViewerWindow(filePath: path)
        }
        // First-time user landing via a .md double-click should still see the
        // welcome — but BEHIND the file viewer, so the file they wanted to read
        // is front-and-center.
        if !welcomeCompleted(), mainWindowController == nil, let port = self.port {
            openMainWindow(url: URL(string: "http://127.0.0.1:\(port)/welcome")!)
            DispatchQueue.main.async { [weak self] in
                self?.viewerControllers.last?.window?.makeKeyAndOrderFront(nil)
            }
        }
    }

    private func setUpMenuBar() {
        let mainMenu = NSMenu()

        // Application menu
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(NSMenuItem(title: "About Memory Map",
                                   action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                                   keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Hide Memory Map",
                                   action: #selector(NSApplication.hide(_:)),
                                   keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "Hide Others",
                                    action: #selector(NSApplication.hideOtherApplications(_:)),
                                    keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(NSMenuItem(title: "Show All",
                                   action: #selector(NSApplication.unhideAllApplications(_:)),
                                   keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit Memory Map",
                                   action: #selector(NSApplication.terminate(_:)),
                                   keyEquivalent: "q"))

        // File menu
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "File")
        fileMenuItem.submenu = fileMenu
        let newWinItem = NSMenuItem(title: "New Window",
                                    action: #selector(newWindow(_:)),
                                    keyEquivalent: "n")
        newWinItem.target = self
        fileMenu.addItem(newWinItem)
        fileMenu.addItem(NSMenuItem(title: "Close Window",
                                    action: #selector(NSWindow.performClose(_:)),
                                    keyEquivalent: "w"))
        fileMenu.addItem(NSMenuItem.separator())
        let resetItem = NSMenuItem(title: "Reset Settings…",
                                   action: #selector(resetSettings(_:)),
                                   keyEquivalent: "")
        resetItem.target = self
        fileMenu.addItem(resetItem)

        // Edit menu (so cut/copy/paste/select-all work in the search input)
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All",
                                    action: #selector(NSText.selectAll(_:)),
                                    keyEquivalent: "a"))
        editMenu.addItem(NSMenuItem.separator())
        let findItem = NSMenuItem(title: "Find",
                                  action: #selector(findInPage(_:)),
                                  keyEquivalent: "f")
        findItem.target = self
        editMenu.addItem(findItem)

        // View menu — navigation + reload, all routed to the key window's webview.
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenuItem.submenu = viewMenu
        let backItem = NSMenuItem(title: "Back",
                                  action: #selector(navBack(_:)),
                                  keyEquivalent: "[")
        backItem.target = self
        viewMenu.addItem(backItem)
        let fwdItem = NSMenuItem(title: "Forward",
                                 action: #selector(navForward(_:)),
                                 keyEquivalent: "]")
        fwdItem.target = self
        viewMenu.addItem(fwdItem)
        viewMenu.addItem(NSMenuItem.separator())
        let reloadItem = NSMenuItem(title: "Reload",
                                    action: #selector(reloadPage(_:)),
                                    keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)

        // Window menu
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(NSMenuItem(title: "Minimize",
                                      action: #selector(NSWindow.performMiniaturize(_:)),
                                      keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Zoom",
                                      action: #selector(NSWindow.performZoom(_:)),
                                      keyEquivalent: ""))
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(NSMenuItem(title: "Bring All to Front",
                                      action: #selector(NSApplication.arrangeInFront(_:)),
                                      keyEquivalent: ""))
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
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
        // Any file opens that arrived before the port was ready.
        drainPendingFileOpens()
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

    func openViewerWindow(filePath: String) {
        // The Open Document AppleEvent can fire before startServer() finishes
        // setting `port` (especially during the build-on-launch step). Queue
        // and drain once the server is ready.
        guard let port = self.port else {
            pendingFileOpens.append(filePath)
            return
        }
        let encoded = filePath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard let url = URL(string: "http://127.0.0.1:\(port)/view?file=\(encoded)") else { return }
        let wc = MemoryMapWindowController(url: url, isPopup: true, appDelegate: self)
        wc.window?.title = (filePath as NSString).lastPathComponent
        wc.window?.delegate = self
        viewerControllers.append(wc)
        wc.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func drainPendingFileOpens() {
        guard !pendingFileOpens.isEmpty else { return }
        let pending = pendingFileOpens
        pendingFileOpens = []
        for path in pending { openViewerWindow(filePath: path) }
    }

    // MARK: menu actions

    private func windowControllerFor(_ win: NSWindow?) -> MemoryMapWindowController? {
        guard let win = win else { return nil }
        if mainWindowController?.window === win { return mainWindowController }
        if let p = popupControllers.first(where: { $0.window === win }) { return p }
        if let v = viewerControllers.first(where: { $0.window === win }) { return v }
        return nil
    }

    @objc func reloadPage(_ sender: Any?) {
        windowControllerFor(NSApp.keyWindow)?.webView.reload()
    }

    @objc func navBack(_ sender: Any?) {
        // Route through the page's gated nav so pre-reload entries in the
        // WKWebView's history aren't reachable.
        windowControllerFor(NSApp.keyWindow)?.webView.evaluateJavaScript(
            "if (typeof window.__mm_back === 'function') window.__mm_back();"
        )
    }

    @objc func navForward(_ sender: Any?) {
        windowControllerFor(NSApp.keyWindow)?.webView.evaluateJavaScript(
            "if (typeof window.__mm_forward === 'function') window.__mm_forward();"
        )
    }

    @objc func findInPage(_ sender: Any?) {
        windowControllerFor(NSApp.keyWindow)?.webView.evaluateJavaScript(
            "if (typeof window.__mm_findInDetail === 'function') window.__mm_findInDetail();"
        )
    }

    @objc func newWindow(_ sender: Any?) {
        guard let port = self.port else { return }
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        if mainWindowController == nil {
            openMainWindow(url: url)
        } else {
            // Additional main-sized window. Tracked in popupControllers for
            // cleanup; isPopup:false so it inherits the larger window size.
            let wc = MemoryMapWindowController(url: url, isPopup: false, appDelegate: self)
            wc.window?.delegate = self
            popupControllers.append(wc)
            wc.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: helpers

    @objc func resetSettings(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Reset Memory Map settings?"
        alert.informativeText = "This deletes ~/Library/Application Support/MemoryMap/config.local.json and rebuilds the data file from scratch. Use this if the app rendered blank or the wrong content after picking a workspace folder or external data file."
        alert.addButton(withTitle: "Reset")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return }

        // Hit /api/reset-config on the server to remove the config + rebuild.
        guard let port = self.port,
              let url = URL(string: "http://127.0.0.1:\(port)/api/reset-config") else {
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let task = URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            DispatchQueue.main.async {
                self?.mainWindowController?.webView.reload()
                self?.popupControllers.forEach { $0.webView.reload() }
            }
        }
        task.resume()
    }

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
            viewerControllers.removeAll { $0.window === closing }
        }
    }
}

// MARK: - Entry point

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
