import { usePlayer, usePlayerPosition } from "@music/player/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { perform } from "@/components/player/controls";
import { hasMod, isTyping } from "@/lib/keys";
import { useLike } from "@/lib/use-like";

import { useUi } from "./ui-state";

const SEEK_STEP_MS = 10_000;

/** The id of the search field that `/` focuses. */
export const SEARCH_INPUT_ID = "search-input";

/**
 * Global shortcuts: space play/pause, ←/→ seek 10 s (with shift: previous/next), ⌘K command menu,
 * N new playlist, `/` search, `l` like the current song, `d` devices.
 */
export function KeyboardShortcuts() {
  const player = usePlayer();
  const position = usePlayerPosition();
  const ui = useUi();
  const navigate = useNavigate();
  const like = useLike(player.track);
  const latest = useRef({ player, position, ui, like });

  latest.current = { player, position, ui, like };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { player: current, position: at, ui: state, like: liking } = latest.current;

      if (hasMod(event) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        state.setCommandOpen(!state.commandOpen);

        return;
      }

      if (
        event.defaultPrevented ||
        isTyping(event) ||
        state.commandOpen ||
        state.newPlaylist !== null
      )
        return;

      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const hasTrack = current.track !== null;

      switch (event.key) {
        case " ": {
          if (!hasTrack || event.target instanceof HTMLButtonElement) return;

          event.preventDefault();
          perform(current.togglePlay());

          return;
        }

        case "ArrowLeft":
        case "ArrowRight": {
          if (!hasTrack || event.target instanceof HTMLInputElement) return;

          event.preventDefault();

          const forward = event.key === "ArrowRight";

          if (event.shiftKey) {
            perform(forward ? current.next() : current.previous());
          } else {
            const target = at + (forward ? SEEK_STEP_MS : -SEEK_STEP_MS);
            perform(current.seek(Math.min(Math.max(0, target), current.durationMs)));
          }

          return;
        }

        case "/": {
          event.preventDefault();
          const field = document.getElementById(SEARCH_INPUT_ID);

          if (field instanceof HTMLInputElement) field.focus();
          else void navigate({ to: "/search" });

          return;
        }

        case "l":
        case "L": {
          if (hasTrack) void liking.toggle();

          return;
        }

        case "n":
        case "N": {
          event.preventDefault();
          state.openNewPlaylist();

          return;
        }

        case "d":
        case "D": {
          if (state.playOn === null) state.openPlayOn();
          else state.closePlayOn();

          return;
        }

        case "Escape": {
          if (state.nowPlaying !== null) state.setNowPlaying(null);

          return;
        }

        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return null;
}
