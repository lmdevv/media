import { usePlayer } from "@music/player/react";
import { Spinner } from "@music/ui/components/spinner";
import { useConvexConnectionState } from "convex/react";
import { useEffect, useState } from "react";

import { plural } from "@/lib/format";

const RECONNECT_GRACE_MS = 1500;

const host = window.location.host;

/**
 * The connection banners from Paper page 10, above the main column: reconnecting to the server
 * (after a short grace period, so brief blips stay quiet) and the media service being down.
 */
export function ConnectionBanners() {
  const connection = useConvexConnectionState();
  const player = usePlayer();
  const disconnected = connection.hasEverConnected && !connection.isWebSocketConnected;
  const [showReconnecting, setShowReconnecting] = useState(false);

  useEffect(() => {
    if (!disconnected) {
      setShowReconnecting(false);

      return undefined;
    }

    const timer = window.setTimeout(() => setShowReconnecting(true), RECONNECT_GRACE_MS);

    return () => window.clearTimeout(timer);
  }, [disconnected]);

  const waiting = connection.inflightMutations + connection.inflightActions;

  return (
    <>
      {showReconnecting ? (
        <div
          role="status"
          className="flex min-h-row shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border bg-surface px-6 py-2 lg:px-12"
        >
          <Spinner label="Reconnecting" className="size-4 text-text" />
          <span className="font-sans text-sm/xs font-medium text-text">
            Reconnecting to {host}…
          </span>
          <span className="font-sans text-sm/xs text-text-muted">
            Music keeps playing. Likes and queue changes sync when the connection is back.
          </span>
          <span className="grow" />
          {waiting > 0 ? (
            <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">
              {plural(waiting, "change")} waiting
            </span>
          ) : null}
        </div>
      ) : null}
      {player.mediaOnline ? null : (
        <div
          role="alert"
          className="flex min-h-row shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border bg-bg px-6 py-2 lg:px-12"
        >
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
          <span className="font-sans text-sm/xs font-medium text-text">
            Can't reach the media service.
          </span>
          <span className="font-sans text-sm/xs text-text-muted">
            You can browse and edit playlists. Playing and scanning are paused.
          </span>
        </div>
      )}
    </>
  );
}
