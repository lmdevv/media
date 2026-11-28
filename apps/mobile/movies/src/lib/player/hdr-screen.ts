/**
 * Whether the screen the app plays on shows HDR video now, as AVFoundation says
 * (`modules/hdr-screen`). False where the module is not linked, so a build without it asks for SDR.
 */
import { requireOptionalNativeModule } from "expo";

/** The app's `HdrScreen` module. */
interface HdrScreen {
  readonly eligibleForHdrPlayback: () => boolean;
}

/** AVFoundation's `AVPlayer.eligibleForHDRPlayback`, read now. */
export const screenShowsHdr = (): boolean =>
  requireOptionalNativeModule<HdrScreen>("HdrScreen")?.eligibleForHdrPlayback() ?? false;
