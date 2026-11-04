import type { Profile } from "@media/contracts/models/profiles";
import type { Scope } from "@media/contracts/scopes";
import type { TrackOption } from "@media/ui/components/track-popover";
import type { CommandGroup, CommandItem } from "@media/ui/lib/command-menu";
import type { useNavigate } from "@tanstack/react-router";

type PlayerRoomCommands = { readonly copyLink: () => void } & (
  | { readonly role: "host"; readonly end: () => void }
  | { readonly role: "guest"; readonly leave: () => void }
);

/** What the open player lets the menu do. */
export interface PlayerCommands {
  readonly playing: boolean;
  /** Solo viewers and room hosts move the timeline; guests follow it. */
  readonly controlsTimeline: boolean;
  readonly togglePlay: () => void;
  readonly skip: (seconds: number) => void;
  readonly toggleFullscreen: () => void;
  /** Opens Stream info; null where the panel cannot show (phones, or before a stream loads). */
  readonly showStreamInfo: (() => void) | null;
  readonly subtitles: ReadonlyArray<TrackOption>;
  readonly subtitleId: string;
  readonly selectSubtitle: (id: string) => void;
  /**
   * The text subtitle's delay, while one shows here: `step(-1)` earlier, `step(1)` later,
   * `step(0)` back to the file's timing. Null when there is nothing it could apply to.
   */
  readonly subtitleDelay: {
    readonly delayMs: number;
    readonly step: (direction: -1 | 0 | 1) => void;
  } | null;
  readonly audio: ReadonlyArray<TrackOption>;
  readonly audioId: string;
  readonly selectAudio: (id: string) => void;
  readonly quality: ReadonlyArray<TrackOption>;
  readonly qualityId: string;
  readonly selectQuality: (id: string) => void;
  /** Versions (files) to switch between; empty unless there are several and switching is allowed. */
  readonly versions: ReadonlyArray<TrackOption>;
  readonly versionId: string;
  readonly selectVersion: (id: string) => void;
  /** Plays the next episode now; null for movies and the last episode. */
  readonly nextEpisode: (() => void) | null;
  /** The playing season's episodes that can play; empty for movies and in rooms. */
  readonly episodes: ReadonlyArray<TrackOption>;
  /** The episode playing, or empty. */
  readonly episodeId: string;
  /** Plays another of `episodes` in the player. */
  readonly selectEpisode: (id: string) => void;
  /** Starts a room for this title; null while in one. */
  readonly startRoom: (() => void) | null;
  /** The room the player is in, or null. */
  readonly room: PlayerRoomCommands | null;
}

/** What every contribution can read and do. */
export interface CommandContext {
  /** The router's `navigate`, typed by the route tree. */
  readonly navigate: ReturnType<typeof useNavigate>;
  /** What is typed in the menu's root list, for contributions that search as people type. */
  readonly query: string;
  /** The active profile; pass its id to profile-scoped commands. */
  readonly profile: Profile;
  /** Every profile of the signed-in account. */
  readonly profiles: ReadonlyArray<Profile>;
  /** What this session may do; gate `manage` and `admin` commands on it. */
  readonly scopes: ReadonlySet<Scope>;
  /**
   * The open player's commands, passed by the player screen that owns them; null everywhere else,
   * so the player's commands leave the menu with the player.
   */
  readonly player: PlayerCommands | null;
}

/** One feature's part of the menu. */
export interface CommandContribution {
  /**
   * Labeled groups in the order the feature wants them. Groups with the same `id` from different
   * features merge into one, in contribution order, so features can share "Actions".
   */
  readonly groups: ReadonlyArray<CommandGroup>;
  /** Commands offered under "No results for …" when the typed query matches nothing. */
  readonly fallback?: ReadonlyArray<CommandItem> | undefined;
}

/** Every contribution combined: the root page's groups and its "No results" commands. */
export interface MergedCommands {
  readonly groups: ReadonlyArray<CommandGroup>;
  readonly fallback: ReadonlyArray<CommandItem>;
}

/** Merges contributions: same-id groups join (first label and options win), fallbacks concatenate. */
export const mergeContributions = (
  contributions: ReadonlyArray<CommandContribution>,
): MergedCommands => {
  const groups = new Map<string, CommandGroup>();

  for (const group of contributions.flatMap((contribution) => contribution.groups)) {
    const existing = groups.get(group.id);

    groups.set(
      group.id,
      existing === undefined ? group : { ...existing, items: [...existing.items, ...group.items] },
    );
  }

  return {
    groups: [...groups.values()].filter((group) => group.items.length > 0),
    fallback: contributions.flatMap((contribution) => contribution.fallback ?? []),
  };
};
