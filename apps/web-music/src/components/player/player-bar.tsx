import { usePlayer } from "@media/player/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";
import { ListMusicIcon } from "lucide-react";

import { Artwork } from "@/components/library/artwork";
import { LikeButton } from "@/components/library/like-button";
import { useUi } from "@/components/shell/ui-state";
import { formatQuality } from "@/lib/format";
import { HOTKEYS } from "@/lib/hotkeys";

import {
  PlayPauseButton,
  Progress,
  RepeatButton,
  ShuffleButton,
  SkipButton,
  Volume,
} from "./controls";
import { perform } from "./player-actions";
import { barTools } from "./bar-tools";

/**
 * The desktop player bar from Paper: the song on the left, transport and progress in the middle,
 * quality, queue, and volume on the right. It shows the buffering, stream error, and media
 * offline states. Old music's device picker returns with Connect.
 */
export function PlayerBar() {
  const player = usePlayer();
  const { setNowPlaying, queueOpen, setQueueOpen } = useUi();
  const track = player.track;

  if (track === null) return null;

  const tools = barTools({ status: player.status, mediaOnline: player.mediaOnline });
  const offline = tools === "offline";
  const failed = tools === "error";
  const buffering = tools === "buffering";

  return (
    <div className="hidden shrink-0 flex-col lg:flex">
      <section
        aria-label="Player"
        className="flex h-20 shrink-0 items-center gap-6 border-t border-border bg-bg px-6 dark:border-transparent dark:bg-dark-canvas"
      >
        <div
          className={cn(
            "flex w-80 shrink-0 items-center gap-3",
            offline && "opacity-(--opacity-disabled)",
          )}
        >
          <button
            type="button"
            aria-label="Open Now Playing"
            onClick={() => setNowPlaying("player")}
            className="shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Artwork
              url={track.artUrl}
              seed={track.albumId}
              className={cn("size-12 rounded-sm", failed && "opacity-(--opacity-disabled)")}
            />
          </button>
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setNowPlaying("player")}
              className="truncate text-left font-sans text-base/sm font-semibold text-text hover:underline"
            >
              {track.title}
            </button>
            {failed ? (
              <span className="truncate font-sans text-sm/xs text-danger">
                Couldn't play this song
              </span>
            ) : (
              <Link
                to="/artists/$artistId"
                params={{ artistId: track.artistId }}
                className="truncate font-sans text-sm/xs text-text-muted hover:text-text hover:underline"
              >
                {track.artist}
              </Link>
            )}
          </div>
          {failed || offline ? null : (
            <LikeButton track={track} shortcut={HOTKEYS["player.like"].defaultHotkey} />
          )}
        </div>

        {offline ? (
          <div role="status" className="flex grow items-center justify-center gap-3">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
            <span className="font-sans text-base/sm text-text">
              Playback is unavailable. [music] can't reach the media service.
            </span>
          </div>
        ) : failed ? (
          <div role="alert" className="flex grow items-center justify-center gap-3">
            <Button variant="outline" size="sm" onClick={() => perform(player.togglePlay())}>
              Retry
            </Button>
            <Button variant="solid" size="sm" onClick={() => perform(player.next())}>
              Skip to next
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 grow flex-col items-center gap-1.5">
            <div className="flex items-center gap-5">
              <ShuffleButton />
              <SkipButton direction="previous" />
              <PlayPauseButton />
              <SkipButton direction="next" />
              <RepeatButton />
            </div>
            <Progress className="max-w-130" />
          </div>
        )}

        <div className="flex w-80 shrink-0 items-center justify-end gap-4">
          {failed ? (
            <span className="truncate font-mono text-xs/xs tracking-mono text-text-muted">
              {player.error}
            </span>
          ) : offline ? null : buffering ? (
            <span className="font-mono text-xs/xs tracking-mono text-text-muted">BUFFERING…</span>
          ) : (
            <>
              <Badge tone="accent">{formatQuality(track)}</Badge>
              <Tooltip label={queueOpen ? "Hide queue" : "Queue"}>
                <button
                  type="button"
                  aria-label="Queue"
                  aria-pressed={queueOpen}
                  onClick={() => setQueueOpen(!queueOpen)}
                  className={cn(
                    "rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    queueOpen ? "text-accent" : "text-text",
                  )}
                >
                  <ListMusicIcon className="size-5" />
                </button>
              </Tooltip>
            </>
          )}
          {tools === "tools" ? <Volume /> : null}
        </div>
      </section>
    </div>
  );
}
