// What AVFoundation makes of each MP4 named on the command line, such as a hardware-matrix cell's
// start.mp4 (an init segment followed by its fragments): whether it exposes a video track, how
// many frames AVAssetReader decodes from it, whether it calls the track HDR, and the transfer its
// format description states. One line per file:
//   <name> video=<true|false> frames=<n> hdr=<true|false> transfer=<function|none> [reader=<error>] [error=<error>]
// With `--play URL [SECONDS]` it plays an HLS stream in AVPlayer instead, muted, for SECONDS (6 by
// default), and prints what AVPlayer made of it: each variant's range and codecs as it read the
// multivariant playlist, whether the item played, and the transfer and primaries of the frames it
// handed out, in a pixel format that keeps 10 bits:
//   variant range=<pq|hlg|sdr|unstated> codecs=<types>
//   played status=<ready|failed|unknown> size=<w>x<h> frames=<n> transfer=<function|none> primaries=<…> eligible=<bool> [error=<error>]
// `eligible` is whether this Mac's display presents HDR (`AVPlayer.eligibleForHDRPlayback`).
// Run on a Mac: `swiftc -O -o apple-check apple-check.swift && ./apple-check *.mp4`.
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

/// A format description's transfer function, as CoreMedia names it (`SMPTE_ST_2084_PQ`).
func transferOf(_ description: CMFormatDescription?) -> String {
    guard let description,
        let value = CMFormatDescriptionGetExtension(
            description, extensionKey: kCMFormatDescriptionExtension_TransferFunction)
    else { return "none" }
    return String(describing: value)
}

func check(_ url: URL) async -> String {
    let asset = AVURLAsset(url: url)
    do {
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            return "video=false frames=0"
        }
        let characteristics = try await track.load(.mediaCharacteristics)
        let descriptions = try await track.load(.formatDescriptions)
        let hdr = characteristics.contains(.containsHDRVideo)
        let colour = "hdr=\(hdr) transfer=\(transferOf(descriptions.first))"
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            ])
        reader.add(output)
        guard reader.startReading() else {
            return "video=true frames=0 \(colour) reader=\(String(describing: reader.error))"
        }
        var frames = 0
        while let sample = output.copyNextSampleBuffer() {
            if CMSampleBufferGetImageBuffer(sample) != nil { frames += 1 }
        }
        let failed = reader.status == .failed ? " reader=\(String(describing: reader.error))" : ""
        return "video=true frames=\(frames) \(colour)\(failed)"
    } catch {
        return "video=false frames=0 error=\(error)"
    }
}

/// A variant's range, as AVFoundation read it from the multivariant playlist.
func rangeOf(_ variant: AVAssetVariant) -> String {
    guard let range = variant.videoAttributes?.videoRange else { return "unstated" }
    switch range {
    case .pq: return "pq"
    case .hlg: return "hlg"
    case .sdr: return "sdr"
    default: return range.rawValue
    }
}

/// An attachment of a pixel buffer, as CoreVideo names its value.
func attachment(_ buffer: CVPixelBuffer, _ key: CFString) -> String {
    guard let value = CVBufferCopyAttachment(buffer, key, nil) else { return "none" }
    return String(describing: value)
}

/// The output's pixel buffer for `time`. macOS 27 deprecates this call for one that answers a
/// read-only buffer type the attachment calls do not take; this one still answers on 27.
func pixelBuffer(_ output: AVPlayerItemVideoOutput, _ time: CMTime) -> CVPixelBuffer? {
    output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil)
}

/// An error as `domain code`, with its underlying error's, for a line of the report.
func described(_ error: Error) -> String {
    let error = error as NSError
    let underlying = (error.userInfo[NSUnderlyingErrorKey] as? NSError).map { " (\($0.domain) \($0.code))" } ?? ""
    return "\(error.domain) \(error.code)\(underlying)"
}

@MainActor
func play(_ url: URL, seconds: Double) async {
    let asset = AVURLAsset(url: url)
    do {
        for variant in try await asset.load(.variants) {
            let codecs = variant.videoAttributes?.codecTypes.map { code in
                String(decoding: withUnsafeBytes(of: code.bigEndian) { Array($0) }, as: UTF8.self)
            } ?? []
            print("variant range=\(rangeOf(variant)) codecs=\(codecs.joined(separator: ","))")
        }
    } catch {
        print("variant range=unread error=\(described(error))")
    }
    let item = AVPlayerItem(asset: asset)
    let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
    ])
    item.add(output)
    let player = AVPlayer(playerItem: item)
    player.isMuted = true
    player.play()
    var frames = 0
    var transfer = "none"
    var primaries = "none"
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        try? await Task.sleep(nanoseconds: 40_000_000)
        let time = output.itemTime(forHostTime: CACurrentMediaTime())
        if output.hasNewPixelBuffer(forItemTime: time), let buffer = pixelBuffer(output, time) {
            frames += 1
            transfer = attachment(buffer, kCVImageBufferTransferFunctionKey)
            primaries = attachment(buffer, kCVImageBufferColorPrimariesKey)
        }
    }
    player.pause()
    let status =
        switch item.status {
        case .readyToPlay: "ready"
        case .failed: "failed"
        default: "unknown"
        }
    let size = "\(Int(item.presentationSize.width))x\(Int(item.presentationSize.height))"
    let failed = item.error.map { " error=\(described($0))" } ?? ""
    print("played status=\(status) size=\(size) frames=\(frames) transfer=\(transfer) primaries=\(primaries) eligible=\(AVPlayer.eligibleForHDRPlayback)\(failed)")
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--play", arguments.count >= 2, let url = URL(string: arguments[1]) {
    await play(url, seconds: arguments.count > 2 ? Double(arguments[2]) ?? 6 : 6)
} else {
    for argument in arguments {
        let url = URL(fileURLWithPath: argument)
        print("\(url.lastPathComponent) \(await check(url))")
    }
}
