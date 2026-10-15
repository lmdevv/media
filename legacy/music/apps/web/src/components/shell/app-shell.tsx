import { useHasTrack } from "@music/player/react";
import { TooltipProvider } from "@music/ui/components/tooltip";
import { CatchBoundary, useLocation } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { JamBand } from "@/components/jam/jam-band";
import { DeviceSheet } from "@/components/player/device-sheet";
import { PlayerBar } from "@/components/player/player-bar";
import { ChunkLoadError, lazyChunk } from "@/lib/lazy-chunk";
import { useOpenedOnce } from "@/lib/use-opened-once";
import { whenSettled } from "@/lib/when-settled";

import { ConnectionBanners } from "./banners";
import { KeyboardShortcuts } from "./keyboard";
import { PhoneChrome } from "./phone-chrome";
import { Sidebar } from "./sidebar";
import { UiStateProvider, useUi } from "./ui-state";

// The surfaces the shell opens on demand load as their own chunks: the command menu with its
// catalog and forms, Now Playing, the queue, the Jam panel with its QR encoder, and the New
// playlist dialog. None of them is on screen when a page first loads.
const surfaces = {
  commandMenu: lazyChunk(
    async () => (await import("@/components/command/command-menu")).CommandMenu,
  ),
  nowPlaying: lazyChunk(async () => (await import("@/components/player/now-playing")).NowPlaying),
  queue: lazyChunk(async () => (await import("@/components/player/queue")).QueuePanel),
  jamPanel: lazyChunk(async () => (await import("@/components/jam/jam-panel")).JamPanel),
  newPlaylist: lazyChunk(
    async () => (await import("@/components/playlists/new-playlist-dialog")).NewPlaylistDialog,
  ),
};

const CommandMenu = surfaces.commandMenu.Component;

const NowPlaying = surfaces.nowPlaying.Component;

const QueuePanel = surfaces.queue.Component;

const JamPanel = surfaces.jamPanel.Component;

const NewPlaylistDialog = surfaces.newPlaylist.Component;

/**
 * Loads the surfaces' chunks once the first screen has settled, so the first ⌘K or tap on the mini
 * player opens at once instead of waiting for the network.
 */
const usePreloadSurfaces = (): void => {
  useEffect(
    () =>
      whenSettled(() => {
        for (const { preload } of Object.values(surfaces)) {
          // A chunk that fails here is asked for again when its surface opens; if that fails too,
          // the surface says so (browsers may keep a failed module until the page reloads).
          preload().catch(() => undefined);
        }
      }),
    [],
  );
};

/** Renders nothing in place of a surface whose code didn't load; any other error goes on up. */
function NoSurface({ error }: ErrorComponentProps): ReactNode {
  if (!(error instanceof ChunkLoadError)) throw error;

  return null;
}

/**
 * A lazily loaded surface. A chunk that fails to load closes the surface and says so, rather than
 * reaching the route's error screen, which would replace the shell and stop the music. A bug in a
 * loaded surface still reaches that screen. A new `attempt` tries the chunk again.
 */
function Loaded({
  attempt,
  onFailed,
  children,
}: {
  readonly attempt: number;
  /** Closes the surface, so the shell (and its shortcuts) don't wait on one that isn't there. */
  readonly onFailed: () => void;
  readonly children: ReactNode;
}) {
  return (
    <CatchBoundary
      getResetKey={() => attempt}
      errorComponent={NoSurface}
      onCatch={(error) => {
        if (!(error instanceof ChunkLoadError)) return;

        onFailed();
        toast.error("Couldn't load this part of [music]. Reload the page to try again.", {
          action: { label: "Reload", onClick: () => window.location.reload() },
        });
      }}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </CatchBoundary>
  );
}

/**
 * Mounts a lazily loaded surface the first time it opens, and keeps it for its close animation.
 * Each opening is a new attempt, so a surface that failed to load tries again.
 */
function OnDemand({
  open,
  onFailed,
  children,
}: {
  readonly open: boolean;
  readonly onFailed: () => void;
  readonly children: ReactNode;
}) {
  const opened = useOpenedOnce(open);
  const [attempt, setAttempt] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);

    if (open) setAttempt((count) => count + 1);
  }

  return opened ? (
    <Loaded attempt={attempt} onFailed={onFailed}>
      {children}
    </Loaded>
  ) : null;
}

/**
 * The signed-in frame. Desktop: sidebar, main column, optional queue panel, and the player bar,
 * inset on white in light mode and as rounded panels on a black canvas in dark mode. Phone: the
 * page with the glass mini player and tab bar floating over it.
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <UiStateProvider>
      {/* Only the signed-in app has tooltips, so their provider (and code) stays out of the
          sign-in and setup screens. */}
      <TooltipProvider>
        <Frame>{children}</Frame>
        <KeyboardShortcuts />
        <Surfaces />
      </TooltipProvider>
    </UiStateProvider>
  );
}

/** The dialogs and sheets the shell opens over every page. */
function Surfaces() {
  const ui = useUi();
  const { commandOpen, setCommandOpen, newPlaylist, closeNewPlaylist } = ui;
  const { nowPlaying, setNowPlaying, jamOpen, setJamOpen } = ui;
  // Only whether a song is loaded: play, pause, buffering, and position reports don't reach them.
  const hasTrack = useHasTrack();
  const { pathname } = useLocation();

  usePreloadSurfaces();

  // Going to another page closes Now Playing. It lives here, not in Now Playing, which mounts
  // only once opened and would close itself on mount.
  useEffect(() => {
    setNowPlaying(null);
  }, [pathname, setNowPlaying]);

  return (
    <>
      <OnDemand open={commandOpen} onFailed={() => setCommandOpen(false)}>
        <CommandMenu />
      </OnDemand>
      <OnDemand open={newPlaylist !== null} onFailed={closeNewPlaylist}>
        <NewPlaylistDialog />
      </OnDemand>
      <OnDemand open={nowPlaying !== null && hasTrack} onFailed={() => setNowPlaying(null)}>
        <NowPlaying />
      </OnDemand>
      <DeviceSheet />
      <OnDemand open={jamOpen} onFailed={() => setJamOpen(false)}>
        <JamPanel />
      </OnDemand>
    </>
  );
}

function Frame({ children }: { readonly children: ReactNode }) {
  const { queueOpen, setQueueOpen } = useUi();
  const hasTrack = useHasTrack();

  return (
    <div className="flex h-dvh flex-col bg-bg dark:bg-dark-canvas">
      <div className="flex min-h-0 grow lg:pt-2 lg:pl-2 lg:dark:gap-2 lg:dark:p-2">
        <Sidebar />
        <div className="flex min-w-0 grow flex-col overflow-clip lg:dark:rounded-md dark:bg-bg">
          <ConnectionBanners />
          <JamBand />
          <main
            id="main"
            className={`relative min-h-0 grow overflow-y-auto overscroll-contain ${hasTrack ? "pb-50" : "pb-35"} lg:pb-0`}
          >
            {children}
          </main>
        </div>
        {queueOpen && hasTrack ? (
          <Loaded attempt={0} onFailed={() => setQueueOpen(false)}>
            <QueuePanel />
          </Loaded>
        ) : null}
      </div>
      <PlayerBar />
      <PhoneChrome />
    </div>
  );
}
