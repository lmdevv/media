/**
 * The parts of Google's Cast Web Sender SDK (`cast_sender.js?loadCastFramework=1`) the music client
 * uses, as the SDK defines them on `window` once it has loaded. Google ships no types with the
 * script, so these describe only what is called here; every global is optional until the SDK says
 * it is available. The movies client declares its own parts (`apps/web-movies/src/casting/`).
 */

/** A cast device as the SDK reports it (`chrome.cast.Receiver`): a name, and no model or codecs. */
interface CastReceiver {
  readonly friendlyName: string;
}

/** An image in a media item's metadata. */
interface CastImage {
  readonly url: string;
}

/** A song's metadata (`chrome.cast.media.MusicTrackMediaMetadata`). */
interface CastMusicMetadata {
  title: string;
  artist: string;
  albumName: string;
  images: Array<CastImage>;
}

/** What the receiver plays. */
interface CastMediaInfo {
  contentUrl: string;
  streamType: string;
  duration: number;
  metadata: CastMusicMetadata;
}

/** A request to load a media item at a position. */
export interface CastLoadRequest {
  autoplay: boolean;
  currentTime: number;
}

/** The media item playing on the receiver. */
interface CastMedia {
  readonly idleReason?: string | null;
}

/** A connection to one receiver. */
export interface CastSession {
  getCastDevice(): CastReceiver;
  /** Settles with undefined when the receiver took the media; a refusal comes as an error code. */
  loadMedia(request: CastLoadRequest): Promise<string | undefined>;
  getMediaSession(): CastMedia | null;
}

/** A change of the cast state or the session state. */
interface CastContextEvent {
  readonly castState?: string;
  readonly sessionState?: string;
}

/** `cast.framework.CastContext`: the page's link to the Cast dialog and the current session. */
export interface CastContext {
  setOptions(options: {
    readonly receiverApplicationId: string;
    readonly autoJoinPolicy: string;
  }): void;
  getCastState(): string;
  getCurrentSession(): CastSession | null;
  /** Rejects with an error code when the listener closes the picker or the device refuses. */
  requestSession(): Promise<string | undefined>;
  endCurrentSession(stopCasting: boolean): void;
  addEventListener(type: string, handler: (event: CastContextEvent) => void): void;
  removeEventListener(type: string, handler: (event: CastContextEvent) => void): void;
}

/** The receiver's player as the sender mirrors it. */
export interface RemotePlayer {
  readonly isConnected: boolean;
  readonly isPaused: boolean;
  readonly isMuted: boolean;
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
  setVolumeLevel(): void;
  muteOrUnmute(): void;
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
    readonly MusicTrackMediaMetadata: new () => CastMusicMetadata;
    readonly LoadRequest: new (mediaInfo: CastMediaInfo) => CastLoadRequest;
  };
}

declare global {
  interface Window {
    readonly cast?: { readonly framework?: CastFramework };
    readonly chrome?: { readonly cast?: ChromeCast };
  }
}
