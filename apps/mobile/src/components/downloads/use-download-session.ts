import { MediaFileNotFound } from "@media/contracts/media-playback";
import type { PlayerPort } from "@media/sdk/effect";
import type { Playback } from "@media/sdk/effect";
import { Result } from "effect";
import { useEffect, useState } from "react";

import { downloadFor } from "@/lib/downloads/model";
import { downloadPlayback } from "@/lib/downloads/playback";
import { useActiveProfile } from "@/session/active-profile";
import { useDownloads } from "@/session/downloads";

const RECORD_EVERY_MS = 10_000;

/**
 * The playback of download `downloadId` and its progress from `player`; null for no download, or
 * while the downloads load. A download that is gone, not ready, or another profile's fails as a
 * missing file.
 */
export const useDownloadSession = (
  downloadId: string | null,
  player: PlayerPort | null,
): Result.Result<Playback.Playback, MediaFileNotFound> | null => {
  const { engine, snapshot } = useDownloads();
  const { profile } = useActiveProfile();

  const download =
    snapshot === null ? undefined : downloadFor(snapshot.store, downloadId, profile.id);

  const open = (): Result.Result<Playback.Playback, MediaFileNotFound> | null => {
    if (downloadId === null || engine === null) return null;

    const playback =
      download === undefined
        ? null
        : downloadPlayback(
            download,
            {
              video: engine.videoUri(download) ?? "",
              subtitle: (trackId) => engine.subtitleUri(download, trackId),
            },
            Date.now(),
          );

    return playback === null
      ? Result.fail(new MediaFileNotFound({ fileId: download?.delivery?.fileId ?? "" }))
      : Result.succeed(playback);
  };

  const [result, setResult] = useState(open);

  if (result === null && engine !== null && downloadId !== null) setResult(open());

  const durationMs = download?.delivery?.durationMs ?? 0;
  const playing = result !== null && Result.isSuccess(result);

  useEffect(() => {
    if (!playing || engine === null || player === null || downloadId === null) return undefined;

    const record = () => {
      const positionMs = player.positionMs();

      if (positionMs > 0) engine.played(downloadId, positionMs, durationMs);
    };

    const unsubscribe = player.subscribe((event) => {
      if (event !== "waiting") record();
    });

    const timer = setInterval(() => {
      if (!player.isPaused()) record();
    }, RECORD_EVERY_MS);

    return () => {
      unsubscribe();
      clearInterval(timer);
      record();
    };
  }, [playing, engine, player, downloadId, durationMs]);

  return result;
};
