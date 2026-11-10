import { join } from "node:path";

import { artworkTicketId } from "@media/contracts/ticket";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { member } from "../devices";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { deploymentTicketKeys } from "../ticket-keys";
import { claimJob, finishJob, moviesLibrary, upsert } from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";
import type { ScannedItem } from "./scanned";

const stack = coreStackFromEnvFile();

const key = (): string => `a1.${unique()}-${unique()}_${unique()}`;

/** A movie whose one video stream carries a codec profile, which is not artwork. */
const withStreamProfile = (item: ScannedItem): ScannedItem => ({
  ...item,
  file: {
    ...item.file,
    probe: {
      ...item.file.probe,
      video: [
        {
          index: 0,
          codec: "h264",
          profile: "High",
          width: 1920,
          height: 1080,
          frameRate: 24,
          bitDepth: 8,
          pixelFormat: "yuv420p",
          hdr: "none",
          bitRate: null,
        },
      ],
    },
  },
});

/** The key a path names and the ticket it carries, as the server's artwork route reads them. */
const parsePath = (path: string | null) => {
  if (path === null) throw new Error("No artwork path");

  const url = new URL(path, "http://media.invalid");

  expect(url.pathname.startsWith("/artwork/")).toBe(true);

  return {
    key: decodeURIComponent(url.pathname.slice("/artwork/".length)),
    ticket: url.searchParams.get("ticket") ?? "",
  };
};

describe.skipIf(stack === undefined)("movies artwork", { timeout: 180_000 }, () => {
  it("answers artwork as paths with a ticket the artwork route admits, and keeps other fields", async () => {
    if (stack === undefined) return;
    const ring = await deploymentTicketKeys();
    const admin = await member(stack, "artwork", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, `Artwork ${unique()}`);
    const [root] = roots;

    if (root === undefined) throw new Error("The library has no folder");

    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const poster = key();
    const logo = key();
    const still = key();

    const film = movieFile(join(root, "Heat.mkv"), 1, 1, {
      ...scannedTitle("movie", `artwork:${unique()}`, "Heat"),
      artwork: { poster, backdrop: poster, logo },
    });

    const show = scannedTitle("show", `artwork:${unique()}`, "Severance");
    const episode = episodeFile(join(root, "Severance", "S01E01.mkv"), show, 1, 1);

    const landed = await upsert(stack, lease, [
      withStreamProfile(film),
      {
        ...episode,
        episode: episode.episode === null ? null : { ...episode.episode, still },
      },
    ]);

    await finishJob(stack, lease);

    if (landed.outcome !== "held") throw new Error(`The scan's write was ${landed.outcome}`);

    const [filmFile, episodeRow] = landed.value.files;

    if (filmFile === undefined || episodeRow === undefined) throw new Error("Nothing landed");

    const detail = await admin.signedIn.client.query(api.movies.titles.get, {
      titleId: filmFile.titleId,
    });

    const posterPath = parsePath(detail.artwork.poster);
    const logoPath = parsePath(detail.artwork.logo);

    expect(posterPath.key).toBe(poster);
    expect(logoPath.key).toBe(logo);
    expect(detail.artwork.backdrop).toBe(detail.artwork.poster);
    expect(detail.files[0]?.probe.video[0]?.profile).toBe("High");

    const episodes = await admin.signedIn.client.query(api.movies.titles.episodes, {
      titleId: episodeRow.titleId,
      seasonNumber: 1,
      paginationOpts: { numItems: 10, cursor: null },
    });

    const stillPath = parsePath(episodes.page[0]?.still ?? null);

    expect(stillPath.key).toBe(still);

    const listed = await admin.signedIn.client.query(api.movies.titles.list, {
      paginationOpts: { numItems: 10, cursor: null },
      libraryId,
    });

    expect(listed.page.find((title) => title.id === filmFile.titleId)?.artwork.poster).toBe(
      detail.artwork.poster,
    );

    const admits = async (path: { readonly key: string; readonly ticket: string }) =>
      (
        await ring.admit(
          {
            ticket: path.ticket,
            route: {
              purposes: ["image"],
              resource: { kind: "artwork", id: await artworkTicketId(path.key) },
            },
            readSession: async () => "unavailable",
          },
          Date.now(),
        )
      ).ok;

    expect(await admits(posterPath)).toBe(true);
    expect(await admits(logoPath)).toBe(true);
    expect(await admits(stillPath)).toBe(true);
    expect(await admits({ key: poster, ticket: logoPath.ticket })).toBe(false);
  });
});
