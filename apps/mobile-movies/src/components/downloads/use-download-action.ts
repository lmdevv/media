import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Check, Download } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import type { EpisodeId, MediaFileId, TitleId } from "@/lib/catalog";
import { statusOf } from "@/lib/downloads/model";
import { downloadHref } from "@/lib/routes";
import { useDownloads } from "@/session/downloads";

/** What to download: a movie, or an episode of a show, in the chosen version. */
export interface DownloadTarget {
  readonly titleId: TitleId;
  /** The episode of a show; omit for a movie. */
  readonly episodeId?: EpisodeId | undefined;
  /** The chosen version, which the download keeps. */
  readonly fileId: MediaFileId;
}

/** The row's text and what pressing it does. */
export interface DownloadAction {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string | undefined;
  /** Queues the download; returns the page to open instead when it is already queued or kept. */
  readonly press: () => string | null;
}

/**
 * The Download row for `target`, or null while no one is signed in here or the title loads. The
 * download is of the version, so another version of the same movie downloads on its own.
 */
export const useDownloadAction = (target: DownloadTarget): DownloadAction | null => {
  const platform = usePlatform();
  const title = usePlatformQuery(platform.movies.titles.get, { titleId: target.titleId });
  const { engine, snapshot } = useDownloads();

  if (engine === null || snapshot === null || title.status !== "success") return null;
  const existing = snapshot.store.downloads.find((download) => download.id === target.fileId);

  if (existing === undefined) {
    return {
      icon: Download,
      title: "Download",
      detail: undefined,
      press: () => {
        engine.add({
          id: target.fileId,
          titleId: target.titleId,
          episodeId: target.episodeId ?? null,
          titleName: title.data.name,
          runtimeMs: title.data.runtimeMs,
          artwork: title.data.artwork.backdrop ?? title.data.artwork.poster,
        });

        return null;
      },
    };
  }

  const href =
    existing.phase === "noSpace"
      ? `${downloadHref(existing.id)}/storage-full`
      : downloadHref(existing.id);

  if (existing.phase === "ready") {
    return { icon: Check, title: "Downloaded", detail: undefined, press: () => href };
  }

  return {
    icon: Download,
    title: existing.phase === "expired" ? "Download" : "Downloading",
    detail: statusOf(existing),
    press: () => href,
  };
};
