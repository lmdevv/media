import { usePlayer } from "@music/player/react";
import type { ReactNode } from "react";

import { CommandMenu } from "@/components/command/command-menu";
import { DeviceSheet } from "@/components/player/device-sheet";
import { NowPlaying } from "@/components/player/now-playing";
import { PlayerBar } from "@/components/player/player-bar";
import { QueuePanel } from "@/components/player/queue";
import { NewPlaylistDialog } from "@/components/playlists/new-playlist-dialog";

import { ConnectionBanners } from "./banners";
import { KeyboardShortcuts } from "./keyboard";
import { PhoneChrome } from "./phone-chrome";
import { Sidebar } from "./sidebar";
import { UiStateProvider, useUi } from "./ui-state";

/**
 * The signed-in frame. Desktop: sidebar, main column, optional queue panel, and the player bar,
 * inset on white in light mode and as rounded panels on a black canvas in dark mode. Phone: the
 * page with the glass mini player and tab bar floating over it.
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <UiStateProvider>
      <Frame>{children}</Frame>
      <KeyboardShortcuts />
      <CommandMenu />
      <NewPlaylistDialog />
      <NowPlaying />
      <DeviceSheet />
    </UiStateProvider>
  );
}

function Frame({ children }: { readonly children: ReactNode }) {
  const { queueOpen } = useUi();
  const player = usePlayer();
  const hasTrack = player.track !== null;

  return (
    <div className="flex h-dvh flex-col bg-bg dark:bg-dark-canvas">
      <div className="flex min-h-0 grow lg:pt-2 lg:pl-2 lg:dark:gap-2 lg:dark:p-2">
        <Sidebar />
        <div className="flex min-w-0 grow flex-col overflow-clip lg:dark:rounded-md dark:bg-bg">
          <ConnectionBanners />
          <main
            id="main"
            className={`relative min-h-0 grow overflow-y-auto overscroll-contain ${hasTrack ? "pb-50" : "pb-35"} lg:pb-0`}
          >
            {children}
          </main>
        </div>
        {queueOpen && hasTrack ? <QueuePanel /> : null}
      </div>
      <PlayerBar />
      <PhoneChrome />
    </div>
  );
}
