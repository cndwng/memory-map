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
        userContent.add(self, name: "downloadFile")
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

    let bundlePath = Bundle.main.bundlePath  // .../MemoryMap.app
    var resourcesDir: String { bundlePath + "/Contents/Resources" }
    var serverScript: String { resourcesDir + "/server.py" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setUpMenuBar()
        startServer()
        guard let port = self.port else {
            showFatalAlert("Memory Map: server failed to start. Check ~/Library/Application Support/MemoryMap/server.log.")
            return
        }
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        openMainWindow(url: url)
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

    @objc func resetSettings(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Reset Memory Map settings?"
        alert.informativeText = "This deletes data/config.local.json and rebuilds the data file from scratch. Use this if the app rendered blank or the wrong content after picking a workspace folder or external data file."
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
        }
    }
}

// MARK: - Entry point

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
