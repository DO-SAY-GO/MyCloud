// mycloud-iphone: list or download the camera roll of a USB-connected iPhone/iPad via ImageCaptureCore.
//   mycloud-iphone list                 -> JSON lines: {"event":"item","key","name","size","created"}
//   mycloud-iphone download <dir>       -> reads wanted keys (JSON array) on stdin, emits {"event":"file","key","path","created"}
import Foundation
import ImageCaptureCore

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["event": "error", "message": message])
    exit(code)
}

final class Importer: NSObject, ICDeviceBrowserDelegate, ICCameraDeviceDelegate, ICCameraDeviceDownloadDelegate {
    let browser = ICDeviceBrowser()
    let mode: String
    let dir: URL?
    let wanted: Set<String>
    var camera: ICCameraDevice?
    var queue: [ICCameraFile] = []
    var current: ICCameraFile?

    init(mode: String, dir: URL?, wanted: Set<String>) {
        self.mode = mode
        self.dir = dir
        self.wanted = wanted
    }

    func start() {
        browser.delegate = self
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue)!
        browser.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            if self.camera == nil { fail("No iPhone found. Plug it in with a cable, unlock it, and tap Trust.", code: 2) }
        }
    }

    static func key(_ f: ICCameraFile) -> String { "\(f.parentFolder?.name ?? "")/\(f.name ?? "")" }
    static func created(_ f: ICCameraFile) -> Double { (f.creationDate ?? f.fileCreationDate ?? Date()).timeIntervalSince1970 }

    // MARK: browser
    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard camera == nil, let cam = device as? ICCameraDevice else { return }
        camera = cam
        cam.delegate = self
        emit(["event": "device", "name": cam.name ?? "iPhone"])
        cam.requestOpenSession()
    }
    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        if device == camera { fail("The iPhone was disconnected.") }
    }

    // MARK: device
    var openAttempts = 0
    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
        guard let error = error else { return }
        // A locked or not-yet-trusted phone refuses the session: keep asking for two minutes.
        openAttempts += 1
        if openAttempts > 40 { fail("Could not open the iPhone: \(error.localizedDescription)") }
        if openAttempts == 1 { emit(["event": "locked", "message": "Unlock your iPhone and tap Trust if asked…"]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { (device as? ICCameraDevice)?.requestOpenSession() }
    }
    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}
    func didRemove(_ device: ICDevice) { fail("The iPhone was disconnected.") }
    func cameraDeviceDidEnableAccessRestriction(_ device: ICDevice) { emit(["event": "locked", "message": "Unlock your iPhone to continue."]) }
    func cameraDeviceDidRemoveAccessRestriction(_ device: ICDevice) {}

    func deviceDidBecomeReady(withCompleteContentCatalog device: ICCameraDevice) {
        let files = (device.mediaFiles ?? []).compactMap { $0 as? ICCameraFile }
        if mode == "list" {
            for f in files {
                emit(["event": "item", "key": Importer.key(f), "name": f.name ?? "", "size": f.fileSize, "created": Importer.created(f)])
            }
            emit(["event": "done"])
            exit(0)
        }
        queue = files.filter { wanted.contains(Importer.key($0)) }
        next()
    }

    func next() {
        guard let f = queue.first, let cam = camera, let dir = dir else {
            emit(["event": "done"])
            exit(0)
        }
        queue.removeFirst()
        current = f
        let options: [ICDownloadOption: Any] = [.downloadsDirectoryURL: dir, .overwrite: true]
        cam.requestDownloadFile(f, options: options, downloadDelegate: self, didDownloadSelector: #selector(didDownloadFile(_:error:options:contextInfo:)), contextInfo: nil)
    }

    @objc func didDownloadFile(_ file: ICCameraFile, error: Error?, options: [String: Any], contextInfo: UnsafeMutableRawPointer?) {
        if let error = error {
            emit(["event": "skip", "key": Importer.key(file), "message": error.localizedDescription])
        } else {
            let saved = (options[ICDownloadOption.savedFilename.rawValue] as? String) ?? file.name ?? ""
            emit(["event": "file", "key": Importer.key(file), "path": dir!.appendingPathComponent(saved).path, "created": Importer.created(file)])
        }
        next()
    }

    // Required by the protocol; nothing to do.
    func cameraDevice(_ camera: ICCameraDevice, didAdd items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didRemove items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveThumbnail thumbnail: CGImage?, for item: ICCameraItem, error: Error?) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveMetadata metadata: [AnyHashable: Any]?, for item: ICCameraItem, error: Error?) {}
    func cameraDevice(_ camera: ICCameraDevice, didRenameItems items: [ICCameraItem]) {}
    func cameraDeviceDidChangeCapability(_ camera: ICCameraDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceivePTPEvent eventData: Data) {}
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "list"
var wanted = Set<String>()
var dir: URL? = nil
if mode == "download" {
    guard args.count > 2 else { fail("usage: mycloud-iphone download <dir>") }
    dir = URL(fileURLWithPath: args[2])
    let input = FileHandle.standardInput.readDataToEndOfFile()
    wanted = Set((try? JSONSerialization.jsonObject(with: input) as? [String]) ?? [])
}
let importer = Importer(mode: mode, dir: dir, wanted: wanted)
importer.start()
RunLoop.main.run()
