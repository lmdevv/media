import type { SourceResolver } from "@media/player/source-resolver";
import { ticketSources } from "@media/player/source-resolver";
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import type { DownloadedCopies } from "@/downloads";
import { trackOf } from "@/lib/test-fixtures";

import { NOT_DOWNLOADED, phoneSources } from "./phone-sources";

const BASE = "http://media.test";

const song = trackOf("Teardrop", "Massive Attack", "Mezzanine");

/** Where the vault keeps `trackId`'s file. */
const uri = (trackId: string): string => `file:///vault/${trackId}.m4a`;

/** The phone's downloads, holding `trackIds`: a copy stops being offered once discarded. */
const downloads = (trackIds: ReadonlyArray<string>) => {
  const held = new Set(trackIds);
  const discarded: Array<string> = [];

  const copies: DownloadedCopies = {
    find: (trackId) =>
      held.has(trackId)
        ? { track: song, uri: uri(trackId), profile: "aac-320", bytes: 1, artUri: null }
        : null,
    discard: (trackId, at) => {
      discarded.push(at);

      if (at === uri(trackId)) held.delete(trackId);
    },
  };

  return { copies, discarded };
};

const streams: SourceResolver = ticketSources(
  async (trackId) => ({
    playbackId: `p-${trackId}`,
    startedAt: 0,
    ticket: "t1",
    expiresAt: 6 * 60 * 60 * 1000,
  }),
  { now: () => 0, baseUrl: BASE },
);

const urlOf = async (sources: SourceResolver): Promise<string> => {
  const resolved = await sources.resolve(song, "aac-320");

  return Result.isSuccess(resolved) ? resolved.success.source.url : resolved.failure.message;
};

describe("phoneSources", () => {
  it("plays the downloaded copy online, and streams the song once the copy failed", async () => {
    const { copies, discarded } = downloads([song.id]);
    const sources = phoneSources(copies, streams, { current: "server" }, () => "1");
    const first = await sources.resolve(song, "aac-320");

    expect(Result.isSuccess(first) ? first.success : null).toMatchObject({
      origin: "local",
      source: { url: uri(song.id) },
    });

    sources.discard(song.id, uri(song.id));

    expect(discarded).toStrictEqual([uri(song.id)]);
    expect(await urlOf(sources)).toBe(`${BASE}/media/music/stream/${song.id}?ticket=t1&p=aac-320`);
  });

  it("answers a song it can't play without the server as unreachable while it plays offline", async () => {
    const { copies } = downloads([song.id]);
    const sources = phoneSources(copies, streams, { current: "local" }, () => "1");

    sources.discard(song.id, uri(song.id));
    const resolved = await sources.resolve(song, "aac-320");

    expect(Result.isFailure(resolved) ? resolved.failure : null).toMatchObject({
      _tag: "SourceUnreachable",
      message: NOT_DOWNLOADED,
    });
  });
});
