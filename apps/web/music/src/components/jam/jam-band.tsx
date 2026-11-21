import { useHasTrack } from "@media/player/react";
import { hostName, shownName, useMusicSession } from "@media/player/session-react";
import type { SessionView } from "@media/player/session-react";
import { UsersRoundIcon } from "lucide-react";

import { useUi } from "@/components/shell/ui-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { AvatarStack } from "./avatars";

const bandText = (view: NonNullable<SessionView>): string => {
  if (view.state === "ended") return "The Jam ended";

  if (view.state === "pending") return `Waiting to join ${hostName(view)}'s Jam`;

  if (view.role === "host") {
    const count = view.members.length;

    return `Your Jam · ${String(count)} ${count === 1 ? "person" : "people"}`;
  }

  return `${hostName(view)}'s Jam`;
};

const actionLabel = (view: NonNullable<SessionView>): string => {
  if (view.state === "ended") return "Back to your music";

  return view.state === "joined" && view.role === "host" ? "Manage" : "Open";
};

/**
 * The Jam band above the main column, on desktop and phone: whose Jam this is and who is in it, or
 * that the Jam ended. Opens the Jam panel.
 */
export function JamBand() {
  const { view } = useMusicSession();
  const { setJamOpen } = useUi();

  if (view === undefined || view === null) return null;

  const ended = view.state === "ended";

  return (
    <output
      aria-label="Jam"
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-3 px-5 lg:px-6",
        ended ? "bg-surface text-text" : "bg-accent text-on-accent",
      )}
    >
      <UsersRoundIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 grow truncate font-sans text-sm/xs font-semibold">
        {bandText(view)}
      </span>
      {view.state === "joined" ? <AvatarStack names={view.members.map(shownName)} /> : null}
      <Button variant={ended ? "solid" : "secondary"} size="sm" onClick={() => setJamOpen(true)}>
        {actionLabel(view)}
      </Button>
    </output>
  );
}

/** "Start a Jam", or "Jam" once there is one: opens the Jam panel. */
export function JamButton({
  tone = "plain",
  className,
}: {
  readonly tone?: "plain" | "glass";
  readonly className?: string;
}) {
  const { view } = useMusicSession();
  const { setJamOpen } = useUi();
  const hasTrack = useHasTrack();
  const idle = view === undefined || view === null || view.state === "ended";

  // A Jam starts from the song playing: with neither, there is nothing to open.
  if (idle && !hasTrack) return null;

  return (
    <button
      type="button"
      onClick={() => setJamOpen(true)}
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 font-sans text-sm/xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        tone === "glass"
          ? "bg-text/8 text-text hover:bg-text/14"
          : "bg-surface text-text hover:bg-border",
        className,
      )}
    >
      <UsersRoundIcon aria-hidden className="size-4" />
      {idle ? "Start a Jam" : "Jam"}
    </button>
  );
}
