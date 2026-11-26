// What AVFoundation makes of each MP4 named on the command line, such as a hardware-matrix cell's
// start.mp4 (an init segment followed by its fragments): whether it exposes a video track, and how
// many frames AVAssetReader decodes from it. One line per file:
//   <name> video=<true|false> frames=<n> [reader=<error>] [error=<error>]
// Run on a Mac: `swiftc -O -o apple-check apple-check.swift && ./apple-check *.mp4`.
import AVFoundation
import CoreMedia
import Foundation

func check(_ url: URL) async -> String {
    let asset = AVURLAsset(url: url)
    do {
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            return "video=false frames=0"
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            ])
        reader.add(output)
        guard reader.startReading() else {
            return "video=true frames=0 reader=\(String(describing: reader.error))"
        }
        var frames = 0
        while let sample = output.copyNextSampleBuffer() {
            if CMSampleBufferGetImageBuffer(sample) != nil { frames += 1 }
        }
        let failed = reader.status == .failed ? " reader=\(String(describing: reader.error))" : ""
        return "video=true frames=\(frames)\(failed)"
    } catch {
        return "video=false frames=0 error=\(error)"
    }
}

for argument in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: argument)
    print("\(url.lastPathComponent) \(await check(url))")
}
