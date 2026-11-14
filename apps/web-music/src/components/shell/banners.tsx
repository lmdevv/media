import { usePlayer } from "@media/player/react";

/**
 * The media server's connection banner from Paper page 10, above the main column. Old music also
 * showed "Reconnecting" from its Convex client's socket state, which the platform SDK does not
 * expose; that banner returns when it does.
 */
export function ConnectionBanners() {
  const player = usePlayer();

  return player.mediaOnline ? null : (
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
  );
}
