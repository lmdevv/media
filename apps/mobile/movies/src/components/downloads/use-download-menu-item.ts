import { describeFailure } from "@media/mobile-core/failure";
import { usePlatform } from "@media/sdk/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Alert } from "react-native";

import { defaultVersion } from "@/components/title/title-model";
import type { EpisodeId, TitleCard } from "@/lib/catalog";
import { downloadOfItem, statusOf } from "@/lib/downloads/model";
import { useDownloads } from "@/session/downloads";

import { keptPageOf } from "./use-download-action";

/** A card menu's Download item: its text, its SF Symbol, and what pressing it does. */
export interface DownloadMenuItem {
  readonly title: "Download" | "Downloaded";
  /** Where a download already queued stands, such as `Downloading · 40%`. */
  readonly subtitle: string | undefined;
  readonly icon: "arrow.down.circle" | "checkmark.circle";
  readonly press: () => void;
}

/**
 * The Download item of a card's menu for a movie, or for one episode of a show (`episodeId`):
 * `Downloaded` once ready, else `Download` with where a queued one stands. It reads the downloads
 * kept on this iPhone, so a card asks the server nothing until the item is pressed; pressing it
 * then queues the version the title page would. Null while no one is signed in here, when nothing
 * is on disk, and for a show without an episode.
 */
export const useDownloadMenuItem = (
  title: TitleCard,
  episodeId: EpisodeId | null,
  available: boolean,
): DownloadMenuItem | null => {
  const platform = usePlatform();
  const { engine, snapshot } = useDownloads();

  if (engine === null || snapshot === null || !available) return null;

  if (title.kind === "show" && episodeId === null) return null;

  const existing = downloadOfItem(snapshot.store, title.id, episodeId);

  if (existing !== undefined) {
    const page = keptPageOf(existing);
    const press = () => router.push(page);

    if (existing.phase === "ready") {
      return { title: "Downloaded", subtitle: undefined, icon: "checkmark.circle", press };
    }

    return { title: "Download", subtitle: statusOf(existing), icon: "arrow.down.circle", press };
  }

  const queue = async () => {
    try {
      const versions = await platform.movies.titles.versions(
        episodeId === null ? { titleId: title.id } : { titleId: title.id, episodeId },
      );

      const file = defaultVersion(versions);

      if (file === undefined) {
        Alert.alert("Couldn't Download", `${title.name} has no file on disk to download.`);

        return;
      }

      engine.add({
        id: file.id,
        titleId: title.id,
        episodeId,
        titleName: title.name,
        runtimeMs: title.runtimeMs,
        artwork: title.artwork.backdrop ?? title.artwork.poster,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (cause) {
      Alert.alert("Couldn't Download", describeFailure(cause));
    }
  };

  return {
    title: "Download",
    subtitle: undefined,
    icon: "arrow.down.circle",
    press: () => void queue(),
  };
};
