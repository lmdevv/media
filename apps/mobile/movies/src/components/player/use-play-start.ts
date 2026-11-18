import { usePlatform } from "@media/sdk/react";
import { Result } from "effect";
import { useEffect, useRef, useState } from "react";

import { startPlay } from "@/lib/player/play-session";
import type { StartArgs, StartedPlay } from "@/lib/player/play-session";
import {
  PlaybackStep,
  PlaybackStop,
  STOPPED_MESSAGE,
  afterSessionFailure,
} from "@/lib/player/policy";
import { useServer } from "@/session/connection";

/** Where a start stands. */
export type PlayStart =
  | { readonly status: "starting" }
  | { readonly status: "started"; readonly play: StartedPlay }
  | { readonly status: "failed"; readonly step: PlaybackStep };

const STARTING: PlayStart = { status: "starting" };

const UNEXPECTED: PlayStart = {
  status: "failed",
  step: PlaybackStep.Stop({ stop: PlaybackStop.Interrupted({ message: STOPPED_MESSAGE }) }),
};

/**
 * Starts `args` once with `movies.play.start`, which takes a new ticket and names a new playback,
 * or does nothing for null. A start opens no stream on the media server, so a component that
 * unmounts before it answers leaves nothing running; the player negotiates its streams.
 */
export const usePlayStart = (args: StartArgs | null): PlayStart => {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const [state, setState] = useState<PlayStart>(STARTING);
  // Development's double mount runs the effect twice; the start goes out once.
  const asked = useRef<Promise<PlayStart> | null>(null);

  useEffect(() => {
    if (args === null) return undefined;

    let live = true;

    asked.current ??= startPlay(platform.movies.play, args, mediaUrl).then(
      (started): PlayStart =>
        Result.match(started, {
          onSuccess: (play) => ({ status: "started", play }),
          onFailure: (failure) => ({ status: "failed", step: afterSessionFailure(failure) }),
        }),
      () => UNEXPECTED,
    );

    void asked.current.then((answered) => {
      if (live) setState(answered);

      return undefined;
    });

    return () => {
      live = false;
    };
  }, [args, platform, mediaUrl]);

  return state;
};
