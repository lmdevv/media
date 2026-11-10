import type { CommandItem, CommandPage } from "@media/ui/lib/command-menu";
import { describe, expect, it } from "vitest";

import type { PlayerCommands } from "./contribution";
import { playbackCommands } from "./playback";

const noop = (): void => undefined;

const recordingPlayer = (overrides: Partial<PlayerCommands> = {}) => {
  const chosen: Array<string> = [];

  const player: PlayerCommands = {
    playing: true,
    togglePlay: noop,
    skip: noop,
    toggleFullscreen: noop,
    showStreamInfo: noop,
    subtitles: [
      { id: "off", label: "Off" },
      { id: "s1", label: "English" },
    ],
    subtitleId: "off",
    selectSubtitle: (id) => {
      chosen.push(`subtitles:${id}`);
    },
    subtitleDelay: null,
    audio: [
      { id: "1", label: "English Stereo" },
      { id: "2", label: "French Stereo" },
    ],
    audioId: "1",
    selectAudio: (id) => {
      chosen.push(`audio:${id}`);
    },
    quality: [
      { id: "auto", label: "Auto" },
      { id: "480p", label: "480p" },
    ],
    qualityId: "auto",
    selectQuality: (id) => {
      chosen.push(`quality:${id}`);
    },
    versions: [],
    versionId: "",
    selectVersion: noop,
    nextEpisode: noop,
    episodes: [],
    episodeId: "",
    selectEpisode: (id) => {
      chosen.push(`episode:${id}`);
    },
    ...overrides,
  };

  return { player, chosen };
};

const items = (player: PlayerCommands): ReadonlyArray<CommandItem> =>
  playbackCommands(player).groups.flatMap((group) => group.items);

const submenu = (player: PlayerCommands, id: string): CommandPage => {
  const item = items(player).find((candidate) => candidate.id === id);

  if (item?.kind !== "submenu") throw new Error(`${id} is not a submenu`);

  return item.page;
};

const delayCommands = (player: PlayerCommands) =>
  items(player)
    .filter((item) => item.id.startsWith("player:subtitles-"))
    .map((item) => [item.title, item.keycaps ?? []]);

const options = (page: CommandPage): ReadonlyArray<CommandItem> =>
  page.groups.flatMap((group) => group.items);

describe("playbackCommands", () => {
  it("offers nothing without a player", () => {
    expect(playbackCommands(null).groups).toEqual([]);
  });

  it("gives the player one Playback group with transport, tracks, and the frame", () => {
    const { player } = recordingPlayer();
    const { groups } = playbackCommands(player);

    expect(groups.map((group) => group.label)).toEqual(["Playback"]);
    expect(items(player).map((item) => item.title)).toEqual([
      "Pause",
      "Back 10 seconds",
      "Forward 10 seconds",
      "Next episode",
      "Subtitles",
      "Audio",
      "Quality",
      "Stream info",
      "Full screen",
    ]);
  });

  it("lists each track with the current one checked, and chooses through the player", () => {
    const { player, chosen } = recordingPlayer();

    for (const [id, expected] of [
      ["player:audio", ["English Stereo", "French Stereo"]],
      ["player:subtitles", ["Off", "English"]],
      ["player:quality", ["Auto", "480p"]],
    ] as const) {
      const list = options(submenu(player, id));

      expect(list.map((option) => option.title)).toEqual(expected);
      expect(list.map((option) => option.checked)).toEqual([true, false]);

      const last = list.at(-1);

      if (last?.kind === "action") void last.perform();
    }

    expect(chosen).toEqual(["audio:2", "subtitles:s1", "quality:480p"]);
  });

  it("lists the season's episodes after Next episode, the playing one checked", () => {
    const episodes = [
      { id: "e1", label: "1. Low Water" },
      { id: "e2", label: "2. Slack Tide" },
    ];

    const { player, chosen } = recordingPlayer({ episodes, episodeId: "e1" });
    const titles = items(player).map((item) => item.title);

    expect(titles.indexOf("Episodes")).toBe(titles.indexOf("Next episode") + 1);

    const list = options(submenu(player, "player:episodes"));

    expect(list.map((option) => [option.title, option.checked])).toEqual([
      ["1. Low Water", true],
      ["2. Slack Tide", false],
    ]);

    const later = list.at(-1);

    if (later?.kind === "action") void later.perform();
    expect(chosen).toEqual(["episode:e2"]);
  });

  it("moves the subtitle delay while a text subtitle shows, and resets one that is set", () => {
    const steps: Array<number> = [];

    const delay = (delayMs: number) => ({
      delayMs,
      step: (direction: -1 | 0 | 1) => {
        steps.push(direction);
      },
    });

    expect(delayCommands(recordingPlayer().player)).toEqual([]);
    expect(delayCommands(recordingPlayer({ subtitleDelay: delay(0) }).player)).toEqual([
      ["Subtitles earlier", ["G"]],
      ["Subtitles later", ["H"]],
    ]);

    const { player } = recordingPlayer({ subtitleDelay: delay(-300) });

    expect(delayCommands(player).map(([title]) => title)).toEqual([
      "Subtitles earlier",
      "Subtitles later",
      "Reset subtitle delay",
    ]);

    for (const item of items(player)) {
      if (item.kind === "action" && item.id.startsWith("player:subtitles-")) void item.perform();
    }

    expect(steps).toEqual([-1, 1, 0]);
  });

  it("drops Stream info where its panel cannot show", () => {
    const { player } = recordingPlayer({ showStreamInfo: null });

    expect(items(player).map((item) => item.title)).not.toContain("Stream info");
  });

  it("drops Audio for a file without audio and adds Version for a title with several files", () => {
    const { player } = recordingPlayer({
      audio: [],
      versions: [
        { id: "a", label: "Remastered" },
        { id: "b", label: "Standard" },
      ],
      versionId: "b",
    });

    const titles = items(player).map((item) => item.title);

    expect(titles).not.toContain("Audio");
    expect(titles).toContain("Version");
    expect(options(submenu(player, "player:version")).map((option) => option.checked)).toEqual([
      false,
      true,
    ]);
  });
});
