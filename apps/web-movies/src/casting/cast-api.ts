/**
 * The parts of Google's Cast Web Sender SDK (`cast_sender.js?loadCastFramework=1`) the web app
 * uses, as the SDK defines them on `window` once it has loaded. Google ships no types with the
 * script, so these describe only what is called here; every global is optional until the SDK says
 * it is available.
 */

/** A cast device as the SDK reports it (`chrome.cast.Receiver`): a name, and no model or codecs. */
interface CastReceiver {
  readonly friendlyName: string;
}

/** An image in a media item's metadata. */
interface CastImage {
  readonly url: string;
}

/** A WebVTT text track of a media item. */
interface CastTrack {
  trackContentId: string;
  trackContentType: string;
  subtype: string;
  name: string;
  language: string;
}

/** Movie or episode metadata; both kinds share these fields. */
interface CastMetadata {
  title: string;
  images: Array<CastImage>;
  seriesTitle?: string;
  season?: number;
  episode?: number;
}

/** What the receiver plays. */
interface CastMediaInfo {
  contentUrl: string;
  streamType: string;
  duration: number;
  metadata: CastMetadata;
  tracks: Array<CastTrack>;
  hlsSegmentFormat?: string;
  hlsVideoSegmentFormat?: string;
}

/** A request to load a media item at a position, with text tracks shown. */
export interface CastLoadRequest {
  autoplay: boolean;
  currentTime: number;
  activeTrackIds: Array<number>;
}

/** A request to show other text tracks; the SDK builds it. */
interface CastEditTracksRequest {
  readonly activeTrackIds: ReadonlyArray<number>;
}

/** A failure the SDK passes to a media command's error callback. */
interface CastError {
  readonly code?: string;
  readonly description?: string | null;
}

/** The media item playing on the receiver. */
interface CastMedia {
  readonly idleReason?: string | null;
  editTracksInfo(
    request: CastEditTracksRequest,
    onSuccess: () => void,
    onError: (error: CastError) => void,
  ): void;
}

/** A connection to one receiver. */
export interface CastSession {
  getCastDevice(): CastReceiver;
  /** Settles with undefined when the receiver took the media; a refusal comes as an error code. */
  loadMedia(request: CastLoadRequest): Promise<string | undefined>;
  getMediaSession(): CastMedia | null;
}

/** `cast.framework.CastContext`: the page's link to the Cast dialog and the current session. */
export interface CastContext {
  setOptions(options: {
    readonly receiverApplicationId: string;
    readonly autoJoinPolicy: string;
  }): void;
  getCastState(): string;
  getCurrentSession(): CastSession | null;
  /** Rejects with an error code when the viewer closes the picker or the device refuses. */
  requestSession(): Promise<string | undefined>;
  endCurrentSession(stopCasting: boolean): void;
  addEventListener(
    type: string,
    handler: (event: { readonly castState?: string; readonly sessionState?: string }) => void,
  ): void;
  removeEventListener(
    type: string,
    handler: (event: { readonly castState?: string; readonly sessionState?: string }) => void,
  ): void;
}

/** The receiver's player as the sender mirrors it. */
export interface RemotePlayer {
  readonly isConnected: boolean;
  readonly isPaused: boolean;
  readonly isMuted: boolean;
  /** False for a receiver whose volume is fixed, such as one a TV sets over HDMI. */
  readonly canControlVolume: boolean;
  readonly duration: number;
  readonly playerState: string | null;
  currentTime: number;
  volumeLevel: number;
}

/** A field of the remote player that changed. */
export interface RemotePlayerChange {
  readonly field: string;
  readonly value: unknown;
}

/** Sends commands to the receiver's player and reports its changes. */
export interface RemotePlayerController {
  playOrPause(): void;
  seek(): void;
  stop(): void;
  muteOrUnmute(): void;
  setVolumeLevel(): void;
  addEventListener(type: string, handler: (event: RemotePlayerChange) => void): void;
  removeEventListener(type: string, handler: (event: RemotePlayerChange) => void): void;
}

/** `cast.framework`. */
export interface CastFramework {
  readonly CastContext: { getInstance(): CastContext };
  readonly CastContextEventType: {
    readonly CAST_STATE_CHANGED: string;
    readonly SESSION_STATE_CHANGED: string;
  };
  readonly RemotePlayer: new () => RemotePlayer;
  readonly RemotePlayerController: new (player: RemotePlayer) => RemotePlayerController;
  readonly RemotePlayerEventType: { readonly ANY_CHANGE: string };
}

/** `chrome.cast`. */
export interface ChromeCast {
  readonly AutoJoinPolicy: { readonly ORIGIN_SCOPED: string };
  readonly Image: new (url: string) => CastImage;
  readonly media: {
    readonly DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    readonly MediaInfo: new (contentId: string, contentType: string) => CastMediaInfo;
    readonly MovieMediaMetadata: new () => CastMetadata;
    readonly TvShowMediaMetadata: new () => CastMetadata;
    readonly Track: new (trackId: number, trackType: string) => CastTrack;
    readonly LoadRequest: new (mediaInfo: CastMediaInfo) => CastLoadRequest;
    readonly EditTracksInfoRequest: new (activeTrackIds: Array<number>) => CastEditTracksRequest;
  };
}

declare global {
  interface Window {
    readonly cast?: { readonly framework?: CastFramework };
    readonly chrome?: { readonly cast?: ChromeCast };
  }
}
