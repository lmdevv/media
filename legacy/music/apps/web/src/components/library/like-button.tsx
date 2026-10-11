import type { Track } from "@music/commands/models";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import { HeartIcon } from "lucide-react";

import { useLike } from "@/lib/use-like";

/** A heart that likes or unlikes a song; filled when liked. */
export function LikeButton({
  track,
  className,
  iconClassName = "size-5",
  shortcut,
}: {
  readonly track: Pick<Track, "id" | "liked" | "title">;
  readonly className?: string;
  readonly iconClassName?: string;
  readonly shortcut?: string | undefined;
}) {
  const { liked, toggle } = useLike(track);
  const label = liked ? "Unlike" : "Like";

  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={`${label} ${track.title}`}
        aria-pressed={liked}
        onClick={(event) => {
          event.stopPropagation();
          void toggle();
        }}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full text-text outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
      >
        <HeartIcon className={iconClassName} fill={liked ? "currentColor" : "none"} />
      </button>
    </Tooltip>
  );
}
