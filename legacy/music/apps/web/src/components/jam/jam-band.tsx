import type { Contributor, Jam } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { cn } from "@music/ui/lib/utils";
import { UsersRoundIcon } from "lucide-react";

import { useUi } from "@/components/shell/ui-state";

import { AvatarStack } from "./avatars";

/** Everyone in a Jam: the host, then the people who joined. */
const peopleIn = (jam: Jam): ReadonlyArray<Contributor> => [
  jam.host,
  ...jam.members.filter((member) => member.status === "joined").map((member) => member.person),
];

/** What the band says about the viewer's Jam. */
const bandText = (jam: Jam, listeningHere: boolean): string => {
  if (jam.status === "ended") return "The Jam ended";

  if (jam.role === "pending") return `Waiting to join ${jam.host.name}'s Jam`;

  if (jam.role === "host") {
    const count = peopleIn(jam).length;

    return `Your Jam · ${String(count)} ${count === 1 ? "person" : "people"}`;
  }

  return `${jam.host.name}'s Jam${listeningHere ? " · listening along here" : ""}`;
};

/** The band's button label. */
const actionLabel = (jam: Jam): string => {
  if (jam.status === "ended") return "Back to your music";

  return jam.role === "host" ? "Manage" : "Open";
};

/**
 * The Jam band above the main column, on desktop and phone: whose Jam this is, who is in it, and
 * whether this device listens along; or that the Jam ended. Opens the Jam panel.
 */
export function JamBand() {
  const { jam, following, isThisDevice } = usePlayer();
  const { setJamOpen } = useUi();

  if (jam === null) return null;

  const ended = jam.status === "ended";

  return (
    <div
      role="status"
      aria-label="Jam"
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-3 px-5 lg:px-6",
        ended ? "bg-surface text-text" : "bg-accent text-on-accent",
      )}
    >
      <UsersRoundIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 grow truncate font-sans text-sm/xs font-semibold">
        {bandText(jam, following && isThisDevice)}
      </span>
      {!ended && jam.role !== "pending" ? <AvatarStack people={peopleIn(jam)} /> : null}
      <Button variant={ended ? "solid" : "secondary"} size="sm" onClick={() => setJamOpen(true)}>
        {actionLabel(jam)}
      </Button>
    </div>
  );
}

/**
 * "Start a Jam", or "Jam" once there is one: opens the Jam panel. Shown in the device list, the
 * queue panel, and Now Playing.
 */
export function JamButton({
  tone = "plain",
  className,
}: {
  readonly tone?: "plain" | "glass";
  readonly className?: string;
}) {
  const { jam } = usePlayer();
  const { setJamOpen } = useUi();
  const me = useRead("account.me", {});
  const idle = jam === null || jam.status === "ended";

  // Guests can't start a Jam (its link could make accounts); in one, they still open it.
  if (idle && (me === undefined || me.role === "guest")) return null;

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
