// mycloud-photos: the Photos library via PhotoKit (Photos.app's scripting interface times out on real libraries).
//   mycloud-photos list            -> JSON lines {"event":"item","id","date","names":[...]}
//   mycloud-photos export <dir>    -> reads asset ids (JSON array) on stdin; writes every original resource
//                                     (photo, Live Photo video, RAW pair…) and emits {"event":"file","id","path","date"}
import Foundation
import Photos

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

let sema = DispatchSemaphore(value: 0)
var status = PHAuthorizationStatus.notDetermined
PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in status = s; sema.signal() }
sema.wait()
guard status == .authorized || status == .limited else {
    emit(["event": "error", "message": "macOS denied Photos access. Allow it in System Settings › Privacy & Security › Photos, then run this again."])
    exit(1)
}

// Originals only: never the edited renders, thumbnails or adjustment data.
let originalTypes: Set<PHAssetResourceType> = [.photo, .video, .audio, .pairedVideo, .alternatePhoto, .fullSizePhoto]
func originals(_ asset: PHAsset) -> [PHAssetResource] {
    let all = PHAssetResource.assetResources(for: asset)
    let base = all.filter { [.photo, .video, .audio, .pairedVideo, .alternatePhoto].contains($0.type) }
    return base.isEmpty ? all.filter { originalTypes.contains($0.type) } : base
}
func when(_ asset: PHAsset) -> Double { (asset.creationDate ?? Date()).timeIntervalSince1970 }

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "list"
let opts = PHFetchOptions()
opts.includeHiddenAssets = true
opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]

if mode == "list" {
    let assets = PHAsset.fetchAssets(with: opts)
    assets.enumerateObjects { asset, _, _ in
        emit(["event": "item", "id": asset.localIdentifier, "date": when(asset), "names": originals(asset).map { $0.originalFilename }])
    }
    emit(["event": "done"])
    exit(0)
}

guard mode == "export", args.count > 2 else {
    emit(["event": "error", "message": "usage: mycloud-photos list | export <dir>"])
    exit(1)
}
let dir = URL(fileURLWithPath: args[2])
let ids = (try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String]) ?? []
let fetched = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
let manager = PHAssetResourceManager.default()
let ropts = PHAssetResourceRequestOptions()
ropts.isNetworkAccessAllowed = true // download iCloud-only originals

fetched.enumerateObjects { asset, _, _ in
    for res in originals(asset) {
        let sub = dir.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        let out = sub.appendingPathComponent(res.originalFilename)
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        manager.writeData(for: res, toFile: out, options: ropts) { err in failure = err; done.signal() }
        done.wait()
        if let failure = failure {
            emit(["event": "skip", "id": asset.localIdentifier, "name": res.originalFilename, "message": failure.localizedDescription])
        } else {
            emit(["event": "file", "id": asset.localIdentifier, "path": out.path, "date": when(asset)])
        }
    }
    emit(["event": "asset", "id": asset.localIdentifier])
}
emit(["event": "done"])
