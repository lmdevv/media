/**
 * Downloads, shared by every device that keeps songs: the iPhone now, the desktop app and the CLI
 * later. The server says what each download means (`downloads.manifest`); this module plans
 * what a device does about it, fetches finished files, and keeps the device's vault in line.
 * Only this entry point is public.
 */
export { DownloadResult, fetchFinishedFile, FetchOutcome } from "./finished-file";

export type { DownloadRequest, FinishedFileRequest, Transfer } from "./finished-file";

export { offlineLibrary } from "./library";

export type { OfflineAlbum, OfflineLibrary, OfflinePlaylist } from "./library";

export { planSync, SyncStep, targetKey } from "./plan";

export type {
  Desired,
  StoredArt,
  StoredCopy,
  StoredMember,
  StoredPin,
  SyncPolicy,
  VaultView,
} from "./plan";

export { canToggleDownload, downloadStatus, trackDownloadState } from "./status";

export type { DownloadStatus } from "./status";

export { DownloadSync, EMPTY_DOWNLOADS } from "./sync";

export type {
  DownloadsSnapshot,
  DownloadSyncOptions,
  DownloadUsage,
  LocalCopy,
  PinView,
  TrackDownloadState,
} from "./sync";

export { VaultChange } from "./vault";

export type { VaultRows, VaultStore } from "./vault";
