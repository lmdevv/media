/**
 * What a screen shows for one song, album, or playlist on this device, read from a
 * `DownloadsSnapshot`. Pure, so every platform's screens agree.
 */
import type { TrackId } from "@music/commands/ids";
import type { DownloadTarget } from "@music/commands/models";

import { targetKey } from "./plan";
import type { DownloadsSnapshot, PinView, TrackDownloadState } from "./sync";

/** Where a download stands on this device. */
export type DownloadStatus =
  | { readonly kind: "none" }
  /** Asked for; nothing fetched yet. */
  | { readonly kind: "queued" }
  | { readonly kind: "downloading"; readonly done: number; readonly total: number }
  | { readonly kind: "downloaded"; readonly bytes: number }
  /** Fetching can't go on until the server answers or space frees up. */
  | { readonly kind: "waiting"; readonly reason: "offline" | "space" }
  /** Every song left to fetch failed; `retry` tries them again. */
  | { readonly kind: "failed"; readonly failed: number; readonly total: number }
  /** The album or playlist is gone, or no longer yours to read. */
  | { readonly kind: "unavailable" }
  /** A song this device keeps because a downloaded album or playlist holds it. */
  | {
      readonly kind: "included";
      readonly by: { readonly kind: "album" | "playlist"; readonly title: string };
    };

const NONE: DownloadStatus = { kind: "none" };

/** An album or playlist download that holds a song. */
type Holder = Extract<DownloadStatus, { readonly kind: "included" }>["by"];

/** Each song an available album or playlist download holds, with the first one that does. */
export const holdersOf = (snapshot: DownloadsSnapshot): ReadonlyMap<TrackId, Holder> => {
  const holders = new Map<TrackId, Holder>();

  for (const { pin, members } of snapshot.pins) {
    if (!pin.available || pin.target.kind === "track") continue;

    for (const { trackId } of members ?? []) {
      if (!holders.has(trackId)) holders.set(trackId, { kind: pin.target.kind, title: pin.title });
    }
  }

  return holders;
};

/** `included` when an album or playlist download holds `trackId`, else `none`. */
const includedStatus = (snapshot: DownloadsSnapshot, trackId: TrackId): DownloadStatus => {
  const by = holdersOf(snapshot).get(trackId);

  return by === undefined ? NONE : { kind: "included", by };
};

/** The status of a download, or of a group of downloads, whose songs are known. */
export const progressOf = (
  snapshot: DownloadsSnapshot,
  members: NonNullable<PinView["members"]>,
): DownloadStatus => {
  let done = 0;
  let total = 0;
  let failed = 0;
  let active = 0;
  let bytes = 0;

  for (const member of members) {
    const state = snapshot.tracks.get(member.trackId);

    if (state === "downloaded") {
      done += 1;
      total += 1;
      bytes += snapshot.copies.get(member.trackId)?.bytes ?? 0;
      continue;
    }

    // A song gone from the server, or in a library that's away, has nothing to fetch.
    if (member.state !== "fetchable") continue;
    total += 1;

    if (state === "failed") failed += 1;

    if (state === "downloading") active += 1;
  }

  if (done === total) return { kind: "downloaded", bytes };

  if (!snapshot.online) return { kind: "waiting", reason: "offline" };

  if (snapshot.lowSpace) return { kind: "waiting", reason: "space" };

  if (failed > 0 && done + failed === total) return { kind: "failed", failed, total };

  return active > 0 || done > 0 ? { kind: "downloading", done, total } : { kind: "queued" };
};

/** Where the download of `target` stands on this device. */
export const downloadStatus = (
  snapshot: DownloadsSnapshot,
  target: DownloadTarget,
): DownloadStatus => {
  const key = targetKey(target);
  const view = snapshot.pins.find(({ pin }) => targetKey(pin.target) === key);

  if (view === undefined)
    return target.kind === "track" ? includedStatus(snapshot, target.id) : NONE;

  if (!view.pin.available) return { kind: "unavailable" };

  if (view.members !== null) return progressOf(snapshot, view.members);

  return snapshot.online ? { kind: "queued" } : { kind: "waiting", reason: "offline" };
};

/**
 * Whether the listener can switch the download on or off now. Adding needs the server; removing
 * works offline; a song kept by its album or playlist goes with it.
 */
export const canToggleDownload = (snapshot: DownloadsSnapshot, status: DownloadStatus): boolean => {
  if (!snapshot.ready || status.kind === "included") return false;

  return status.kind !== "none" || snapshot.online;
};

/** What this device holds or is getting for one song, for its row's glyph. */
export const trackDownloadState = (
  snapshot: DownloadsSnapshot,
  trackId: TrackId,
): TrackDownloadState | "none" => snapshot.tracks.get(trackId) ?? "none";
