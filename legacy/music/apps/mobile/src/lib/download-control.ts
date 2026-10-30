/**
 * The download control in an album's or playlist's header (Paper's downloads proposal, variant A,
 * D01 and D04): a ring beside More that downloads, shows progress by songs, cancels, and asks
 * before it removes what is already here.
 */
import type { DownloadTarget } from "@music/commands/models";
import type { DownloadStatus, DownloadUsage } from "@music/sdk/downloads";
import { Match } from "effect";

import type { DeviceFamily } from "./device-family";
import { countOf, formatBytes } from "./format";

/** What the ring draws. */
export type DownloadRing =
  | { readonly kind: "idle" }
  /** Queued, or waiting for the server or for space: a dashed ring with a stop square. */
  | { readonly kind: "waiting" }
  /** The share of songs finished, from 0 to 1, so the ring never runs backwards. */
  | { readonly kind: "downloading"; readonly progress: number }
  | { readonly kind: "downloaded" };

/** What pressing the ring does. */
type DownloadPress = "download" | "cancel" | "confirm-remove" | "none";

/** The ring, its press, and what VoiceOver reads for it. */
export interface DownloadControl {
  readonly ring: DownloadRing;
  readonly press: DownloadPress;
  readonly label: string;
}

const WAITING = { kind: "waiting" } as const;

const DOWNLOADED = { kind: "downloaded" } as const;

/** The control for a download in `status`; `canToggle` is false while it can't change. */
export const downloadControl = (
  status: DownloadStatus,
  canToggle: boolean,
  family: DeviceFamily,
): DownloadControl => {
  const control = Match.value(status).pipe(
    Match.discriminatorsExhaustive("kind")({
      none: (): DownloadControl => ({
        ring: { kind: "idle" },
        press: "download",
        label: canToggle ? "Download" : "Download, needs a connection to the server",
      }),
      queued: (): DownloadControl => ({
        ring: WAITING,
        press: "cancel",
        label: "Cancel download, waiting to download",
      }),
      waiting: ({ reason }): DownloadControl => ({
        ring: WAITING,
        press: "cancel",
        label:
          reason === "offline"
            ? "Cancel download, waiting for a connection to the server"
            : `Cancel download, waiting for space on this ${family}`,
      }),
      downloading: ({ done, total }): DownloadControl => ({
        ring: { kind: "downloading", progress: total === 0 ? 0 : done / total },
        press: "cancel",
        label: `Cancel download, ${String(done)} of ${String(total)} songs downloaded`,
      }),
      // Paper's D05: an album with some songs here stays downloaded, and its rows say which songs
      // to retry. With none here it isn't downloaded, so it waits for its retries instead.
      failed: ({ failed, total }): DownloadControl =>
        failed < total
          ? {
              ring: DOWNLOADED,
              press: "confirm-remove",
              label: `Downloaded, ${String(failed)} of ${String(total)} songs couldn’t download. Remove download`,
            }
          : {
              ring: WAITING,
              press: "cancel",
              label: `Cancel download, ${countOf(failed, "song")} couldn’t download`,
            },
      downloaded: (): DownloadControl => ({
        ring: DOWNLOADED,
        press: "confirm-remove",
        label: "Downloaded. Remove download",
      }),
      unavailable: (): DownloadControl => ({
        ring: DOWNLOADED,
        press: "confirm-remove",
        label: "Download no longer available. Remove download",
      }),
      included: ({ by }): DownloadControl => ({
        ring: DOWNLOADED,
        press: "none",
        label: `Downloaded with ${by.title}`,
      }),
    }),
  );

  return canToggle ? control : { ...control, press: "none" };
};

/** What a Remove download sheet says, and its confirm button, like C12's Delete playlist. */
export interface RemoveCopy {
  readonly body: string;
  readonly confirmLabel: string;
}

/** D17's Remove all downloads sheet, for the songs and space downloads take now. */
export const removeAllCopy = (usage: DownloadUsage, family: DeviceFamily): RemoveCopy =>
  usage.tracks === 0
    ? {
        body: `Downloads still to come stop, and nothing is kept on this ${family}. Nothing changes on your server, and you can download them again any time.`,
        confirmLabel: "Remove all downloads",
      }
    : {
        body: `${countOf(usage.tracks, "song")} and ${formatBytes(usage.bytes)} leave this ${family}. Nothing changes on your server, and you can download them again any time.`,
        confirmLabel: `Remove ${formatBytes(usage.bytes)}`,
      };

/** The space a download takes on this iPhone, and the part of it that only it keeps. */
export interface DownloadSpace {
  readonly bytes: number;
  readonly freedBytes: number;
}

/** The Remove download sheet for `title`, a `kind`: it frees only what no other download keeps. */
export const removeDownloadCopy = (
  title: string,
  kind: DownloadTarget["kind"],
  { bytes, freedBytes }: DownloadSpace,
  family: DeviceFamily,
): RemoveCopy => {
  const freed = formatBytes(freedBytes);

  const leaving =
    freedBytes === bytes
      ? bytes > 0
        ? `${title} and the ${freed} it takes leave this ${family}.`
        : `${title} leaves this ${family}.`
      : freedBytes > 0
        ? `${title} leaves your downloads and frees ${freed}. Songs your other downloads keep stay on this ${family}.`
        : kind === "track"
          ? `${title} leaves your downloads, and stays on this ${family} with your other downloads.`
          : `${title} leaves your downloads. Its songs stay on this ${family} with your other downloads.`;

  return {
    body: `${leaving} Nothing changes on your server, and you can download it again any time.`,
    confirmLabel: freedBytes > 0 ? `Remove ${freed}` : "Remove download",
  };
};
