/**
 * The Download rows of the song (A11) and playlist (C08) sheets, per Paper's downloads proposal:
 * Download, Cancel download while songs are still coming, Remove download once they're here, and
 * Retry download above Cancel download once songs failed.
 */
import type { DownloadStatus } from "@music/sdk/downloads";
import { Match } from "effect";

import type { DeviceFamily } from "./device-family";
import { formatBytes } from "./format";

/** What pressing a row does. */
type DownloadRowAction = "download" | "retry" | "remove" | "none";

/** The row's glyph, which says what the row is about even when pressing it does nothing. */
type DownloadRowIcon = "download" | "retry" | "remove" | "downloaded";

/** A row's words, glyph, and press. */
export interface DownloadRowLabel {
  readonly action: DownloadRowAction;
  readonly icon: DownloadRowIcon;
  readonly title: string;
  readonly subtitle: string | null;
}

/** Cancel download, with what is happening to the songs still to come. */
const cancel = (subtitle: string | null): DownloadRowLabel => ({
  action: "remove",
  icon: "remove",
  title: "Cancel download",
  subtitle,
});

/**
 * The rows for a download in `status`; `canToggle` is false while adding needs the server, and
 * `freedBytes` is the space removing it frees, less the songs another download keeps.
 */
export const downloadRows = (
  status: DownloadStatus,
  canToggle: boolean,
  freedBytes: number,
  family: DeviceFamily,
): ReadonlyArray<DownloadRowLabel> =>
  Match.value(status).pipe(
    Match.discriminatorsExhaustive("kind")({
      none: (): ReadonlyArray<DownloadRowLabel> => [
        {
          action: canToggle ? "download" : "none",
          icon: "download",
          title: "Download",
          subtitle: canToggle ? null : "Downloads need a connection to the server",
        },
      ],
      queued: (): ReadonlyArray<DownloadRowLabel> => [cancel("Waiting to download")],
      downloading: ({ done, total }): ReadonlyArray<DownloadRowLabel> => [
        cancel(`Downloading ${String(done)} of ${String(total)}`),
      ],
      waiting: ({ reason }): ReadonlyArray<DownloadRowLabel> => [
        cancel(
          reason === "offline"
            ? "Waiting for a connection to the server"
            : `Waiting for space on this ${family}`,
        ),
      ],
      failed: ({ failed, total }): ReadonlyArray<DownloadRowLabel> => [
        {
          action: "retry",
          icon: "retry",
          title: "Retry download",
          subtitle: `Couldn’t download ${String(failed)} of ${String(total)}`,
        },
        cancel(null),
      ],
      downloaded: ({ bytes }): ReadonlyArray<DownloadRowLabel> => [
        {
          action: "remove",
          icon: "remove",
          title: "Remove download",
          subtitle:
            freedBytes > 0
              ? `Frees ${formatBytes(freedBytes)} on this ${family}`
              : bytes > 0
                ? `Stays on this ${family} with your other downloads`
                : `Takes no space on this ${family}`,
        },
      ],
      unavailable: (): ReadonlyArray<DownloadRowLabel> => [
        {
          action: "remove",
          icon: "remove",
          title: "Remove download",
          subtitle: "No longer available",
        },
      ],
      included: ({ by }): ReadonlyArray<DownloadRowLabel> => [
        { action: "none", icon: "downloaded", title: "Downloaded", subtitle: `With ${by.title}` },
      ],
    }),
  );
