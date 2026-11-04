import { cn } from "@media/ui/lib/utils";

import { Avatar } from "./avatar";
import { Button } from "./button";

/**
 * What a room member's row says at its right edge. Members in step say nothing: Paper removed the
 * routine "in sync" label as noise.
 */
export type RoomMemberStatus =
  /** Off the shared position by `label`, such as `-2.4s`. */
  | { readonly kind: "drift"; readonly label: string }
  /** Catching up to the room after joining. */
  | { readonly kind: "syncing" }
  /** The host's connection froze the room. */
  | { readonly kind: "buffering" }
  /** Still in the room, browsing elsewhere in the app; muted rather than a warning. */
  | { readonly kind: "away" }
  /** Gone from the room; the row dims. */
  | { readonly kind: "left" };

/** Someone in a watch room. */
export type RoomMember = {
  readonly id: string;
  readonly name: string;
  /** `Host` or `You`; omit for other guests. */
  readonly detail?: string | undefined;
  readonly avatar?: string | undefined;
  readonly status?: RoomMemberStatus | undefined;
};

const statusLabel = (status: RoomMemberStatus): string =>
  status.kind === "drift" ? status.label : status.kind;

/**
 * The watch-together panel beside the player: who is watching and who is out of step, with the
 * invite link and End room for the host, or Leave room for guests.
 *
 * @param paused - The room is paused for everyone (host buffering or away); the dot turns amber.
 * @param onCopyLink - Copies the invite link; omit to hide the button (guests).
 * @param onEnd - Ends the room for everyone; omit for guests.
 * @param onLeave - Leaves the room; omit for the host.
 */
export function RoomPanel({
  members,
  paused = false,
  onCopyLink,
  onEnd,
  onLeave,
  className,
}: {
  readonly members: ReadonlyArray<RoomMember>;
  readonly paused?: boolean;
  readonly onCopyLink?: (() => void) | undefined;
  readonly onEnd?: (() => void) | undefined;
  readonly onLeave?: (() => void) | undefined;
  readonly className?: string;
}) {
  return (
    <section
      aria-label="Watching together"
      data-slot="room-panel"
      className={cn(
        "on-media flex w-95 flex-col gap-7 border-l border-hairline bg-dark-surface px-6 pt-8 pb-7 font-sans",
        className,
      )}
    >
      <h2 className="flex items-center gap-2 text-heading/heading font-bold text-text">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-pill", paused ? "bg-warning" : "bg-accent")}
        />
        Watching together
      </h2>
      <ul className="flex grow flex-col gap-5">
        {members.map((member) => {
          const left = member.status?.kind === "left";
          const quiet = left || member.status?.kind === "away";

          return (
            <li key={member.id} className="flex items-center gap-3">
              <Avatar
                name={member.name}
                image={member.avatar}
                round
                className={cn("size-10", left && "opacity-35")}
              />
              <span className="flex min-w-0 grow basis-0 flex-col">
                <span
                  className={cn(
                    "truncate text-body/5 font-semibold",
                    left ? "text-text-muted" : "text-text",
                  )}
                >
                  {member.name}
                </span>
                {member.detail === undefined ? null : (
                  <span className="truncate text-label/label text-text-muted">{member.detail}</span>
                )}
              </span>
              {member.status === undefined ? null : (
                <span
                  className={cn(
                    "w-18 shrink-0 text-right font-mono text-caption/caption",
                    quiet ? "text-text-muted" : "text-warning",
                  )}
                >
                  {statusLabel(member.status)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {onCopyLink === undefined && onEnd === undefined && onLeave === undefined ? null : (
        <div className="flex gap-2">
          {onCopyLink === undefined ? null : (
            <Button
              variant="subtle"
              size="md"
              className="flex-1 text-label/caption"
              onClick={onCopyLink}
            >
              Copy invite link
            </Button>
          )}
          {onEnd === undefined ? null : (
            <Button variant="ghost" size="md" className="px-3.5 text-label/caption" onClick={onEnd}>
              End room
            </Button>
          )}
          {onLeave === undefined ? null : (
            <Button
              variant="ghost"
              size="md"
              className="flex-1 text-label/caption"
              onClick={onLeave}
            >
              Leave room
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
