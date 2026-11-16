import { usePlayer } from "@media/player/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";
import { ListMusicIcon, SpeakerIcon } from "lucide-react";
import { useEffect } from "react";

import { Artwork } from "@/components/library/artwork";
import { LikeButton } from "@/components/library/like-button";
import { useUi } from "@/components/shell/ui-state";
import { formatQuality } from "@/lib/format";
import { HOTKEYS } from "@/lib/hotkeys";
import { useIsDesktop } from "@/lib/use-media";

import {
  PlayPauseButton,
  Progress,
  RepeatButton,
  ShuffleButton,
  SkipButton,
  Volume,
} from "./controls";
import { perform, playingElsewhere } from "./player-actions";
import { barTools } from "./bar-tools";
import { DeviceList } from "./devices";
import { shownSurface } from "./play-on";

/**
 * The desktop player bar from Paper: the song on the left, transport and progress in the middle,
 * quality, queue, device, and volume on the right. It shows the buffering, stream error, media
 * offline, and remote control states. Volume stays with the device that plays, as Connect keeps no
 * remote volume (ADR 0018), so the bar hides it while another device plays.
 */
export function PlayerBar() {
  const player = usePlayer();
  const { setNowPlaying, queueOpen, setQueueOpen } = useUi();
  const track = player.track;
  const { remote } = player;

  if (track === null) return null;

  const tools = barTools({
    status: player.status,
    mediaOnline: player.mediaOnline,
    remote: remote !== null,
  });

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
              {remote === null ? (
                <Badge tone="accent">{formatQuality(track)}</Badge>
              ) : (
                <Badge tone="surface" className="max-w-40 text-text">
                  <span className="truncate">On {remote.name}</span>
                </Badge>
              )}
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
          <DevicePickerButton />
          {tools === "tools" && remote === null ? <Volume /> : null}
        </div>
      </section>
      <RemoteBand />
    </div>
  );
}

function DevicePickerButton() {
  const { playOn, openPlayOn, closePlayOn, setPlayOnPopoverMounted } = useUi();
  const onlineCount = usePlayer().devices.length + 1;
  const desktop = useIsDesktop();
  const shown = shownSurface(playOn, desktop);

  useEffect(() => {
    setPlayOnPopoverMounted(true);

    return () => setPlayOnPopoverMounted(false);
  }, [setPlayOnPopoverMounted]);

  return (
    <Popover
      open={shown === "popover"}
      onOpenChange={(open) => (open ? openPlayOn() : closePlayOn())}
    >
      <Tooltip label="Play on another device" shortcut={HOTKEYS["devices.toggle"].defaultHotkey}>
        <PopoverTrigger
          aria-label="Play on another device"
          className="rounded-full text-text outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:text-accent"
        >
          <SpeakerIcon className="size-5" />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="w-95 gap-0.5 p-2">
        <div className="flex items-center justify-between px-3 pt-2.5 pb-2">
          <span className="font-sans text-md/base font-semibold text-text">Play on</span>
          <span className="font-mono text-xs/xs tracking-mono text-text-muted">
            {onlineCount === 1 ? "1 DEVICE ONLINE" : `${onlineCount} DEVICES ONLINE`}
          </span>
        </div>
        <DeviceList />
      </PopoverContent>
    </Popover>
  );
}

function RemoteBand() {
  const elsewhere = playingElsewhere(usePlayer());

  if (elsewhere === null) return null;

  const { Icon, name } = elsewhere;

  return (
    <div
      role="status"
      className="flex h-7 shrink-0 items-center justify-end gap-2 bg-accent px-6 text-on-accent"
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="font-sans text-sm/xs font-semibold">Playing on {name}</span>
    </div>
  );
}
