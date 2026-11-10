/**
 * Types the libraries do not ship: media APIs that Safari has and TypeScript's DOM library does not
 * describe yet (each optional, so code checks that it exists). A script file, so these merge into
 * the global DOM interfaces.
 */
interface Window {
  /** Media Source Extensions as iPhones offer them (Safari 17.1 and later). */
  readonly ManagedMediaSource?: typeof MediaSource;
}

interface HTMLVideoElement {
  /** Opens the AirPlay picker (Safari). */
  readonly webkitShowPlaybackTargetPicker?: () => void;
  /** Whether the video plays on an AirPlay device (Safari). */
  readonly webkitCurrentPlaybackTargetIsWireless?: boolean;
  /** Whether a presentation mode such as `picture-in-picture` works here (Safari). */
  readonly webkitSupportsPresentationMode?: (mode: string) => boolean;
  /** Enters `inline`, `fullscreen`, or `picture-in-picture` (Safari). */
  readonly webkitSetPresentationMode?: (mode: string) => void;
  /** The presentation mode now (Safari). */
  readonly webkitPresentationMode?: string;
  /** Plays the video full screen in the system player (iPhone Safari). */
  readonly webkitEnterFullscreen?: () => void;
}
