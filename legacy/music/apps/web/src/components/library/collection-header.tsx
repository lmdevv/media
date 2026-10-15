import type { Track } from "@music/commands/models";
import { Button } from "@music/ui/components/button";
import { cn } from "@music/ui/lib/utils";
import { useRouter } from "@tanstack/react-router";
import { ChevronLeftIcon, PlayIcon, PlusIcon, ShuffleIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { CollectionMenu } from "@/components/playlists/collection-menu";
import { glassClassName } from "@/components/shell/phone-chrome";
import { useUi } from "@/components/shell/ui-state";
import type { LinkTarget } from "@/lib/use-copy-link";

import { usePlayTracks } from "./cards";

/**
 * The album-style header from Paper (album, playlist, liked songs): a large cover beside a mono
 * eyebrow, the display title, a subtitle, and Play / Shuffle / more. Phones center it iOS-style
 * with Play and Shuffle pills.
 */
export function CollectionHeader({
  cover,
  phoneCover,
  eyebrow,
  title,
  subtitle,
  phoneSubtitle,
  phoneMeta,
  badge,
  tracks,
  link,
  menuExtra,
  actions,
}: {
  readonly cover: ReactNode;
  readonly phoneCover: ReactNode;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: ReactNode;
  readonly phoneSubtitle?: ReactNode;
  readonly phoneMeta?: string;
  readonly badge?: ReactNode;
  readonly tracks: ReadonlyArray<Track>;
  /** What the menu's "Copy link" links to. */
  readonly link?: LinkTarget | undefined;
  readonly menuExtra?: ReactNode;
  /** Buttons after the menu, such as Share. */
  readonly actions?: ReactNode;
}) {
  const play = usePlayTracks();
  const router = useRouter();
  const { openNewPlaylist } = useUi();
  const [pending, setPending] = useState<"play" | "shuffle" | null>(null);
  const empty = tracks.length === 0;

  const start = async (shuffle: boolean) => {
    setPending(shuffle ? "shuffle" : "play");
    await play(tracks, { shuffle });
    setPending(null);
  };

  return (
    <>
      <header className="hidden items-end gap-8 lg:flex">
        {cover}
        <div className="flex min-w-0 grow flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">
              {eyebrow}
            </span>
            <h1 className="line-clamp-2 font-sans text-2xl/2xl font-heavy tracking-display text-text xl:text-display/display">
              {title}
            </h1>
            <div className="font-sans text-lg/lg font-medium text-text">{subtitle}</div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              disabled={empty}
              pending={pending === "play"}
              onClick={() => void start(false)}
            >
              <PlayIcon fill="currentColor" strokeWidth={0} />
              Play
            </Button>
            <Button
              variant="secondary"
              disabled={empty}
              pending={pending === "shuffle"}
              onClick={() => void start(true)}
            >
              <ShuffleIcon />
              Shuffle
            </Button>
            <CollectionMenu tracks={tracks} label={title} link={link} extra={menuExtra} />
            {actions}
            {badge}
          </div>
        </div>
      </header>

      <header className="flex flex-col items-center pt-1 lg:hidden">
        <div className="flex justify-between self-stretch">
          <button
            type="button"
            aria-label="Back"
            onClick={() => router.history.back()}
            className={cn(
              "flex size-11 items-center justify-center rounded-full text-text",
              glassClassName,
            )}
          >
            <ChevronLeftIcon className="size-5.5" strokeWidth={2.2} />
          </button>
          <div className="flex gap-2.5">
            <button
              type="button"
              aria-label="Add to a new playlist"
              disabled={empty}
              onClick={() => openNewPlaylist(tracks.map((track) => track.id))}
              className={cn(
                "flex size-11 items-center justify-center rounded-full text-text",
                glassClassName,
              )}
            >
              <PlusIcon className="size-5" strokeWidth={2} />
            </button>
            <CollectionMenu
              tracks={tracks}
              label={title}
              link={link}
              extra={menuExtra}
              className={cn("size-11 border-hairline", glassClassName)}
            />
          </div>
        </div>
        <div className="mt-3.5">{phoneCover}</div>
        <div className="flex flex-col items-center gap-0.5 px-6 pt-5 text-center">
          <h1 className="font-sans text-phone-title leading-lg font-bold tracking-snug text-text">
            {title}
          </h1>
          <div className="font-sans text-phone-title leading-lg text-accent">
            {phoneSubtitle ?? subtitle}
          </div>
          {phoneMeta === undefined ? null : (
            <span className="pt-1 font-sans text-xs/xs font-medium text-text-muted">
              {phoneMeta}
            </span>
          )}
        </div>
        <div className="flex gap-3.5 self-stretch pt-4.5">
          <button
            type="button"
            disabled={empty}
            onClick={() => void start(false)}
            className="flex h-12 grow basis-0 items-center justify-center gap-2 rounded-3xl bg-surface font-sans text-md/base font-semibold text-accent disabled:opacity-(--opacity-disabled)"
          >
            <PlayIcon className="size-4" fill="currentColor" strokeWidth={0} />
            Play
          </button>
          <button
            type="button"
            disabled={empty}
            onClick={() => void start(true)}
            className="flex h-12 grow basis-0 items-center justify-center gap-2 rounded-3xl bg-surface font-sans text-md/base font-semibold text-accent disabled:opacity-(--opacity-disabled)"
          >
            <ShuffleIcon className="size-4.5" strokeWidth={2.2} />
            Shuffle
          </button>
        </div>
      </header>
    </>
  );
}
