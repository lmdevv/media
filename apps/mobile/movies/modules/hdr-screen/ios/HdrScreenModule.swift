import AVFoundation
import ExpoModulesCore

/// Whether the screen the app plays on shows HDR video now (`@/lib/player/hdr-screen`).
///
/// `eligibleForHdrPlayback` answers AVFoundation's `AVPlayer.eligibleForHDRPlayback`: true when an
/// HDR display is available and the device plays HDR to it, false on an SDR screen, such as an
/// iPhone mirrored to an SDR television, where AVPlayer still decodes HDR but maps it to SDR
/// itself. It names no format: every device it is true on presents HDR10 and HLG.
public final class HdrScreenModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HdrScreen")

    Function("eligibleForHdrPlayback") { () -> Bool in
      AVPlayer.eligibleForHDRPlayback
    }
  }
}
