import type { FunctionArgs } from "convex/server";
import { beforeAll, describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { insertByHand, patchByHand } from "../../admin";
import { member } from "../../devices";
import { guestsOn, makeLink, openLink } from "../../guests";
import { allPages, at, onAlbum } from "../../music/shelf";
import { movie, seedLibrary, show } from "../../probe";
import type { Session } from "../../probe";
import { refusal, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const page = { numItems: 200, cursor: null };

const seed = async (core: CoreStack) => {
  const admin = await guestsOn(core);
  const maker = await member(core, "detail-maker");
  await admin.signedIn.client.mutation(api.core.guests.allow, {
    userId: maker.userId,
    allowed: true,
  });

  const films = await seedLibrary(core, maker, {
    name: unique(),
    kind: "movies",
    items: [movie("Shared Movie", 0), show("Shared Show", 0, 3), movie("Other Movie", 0)],
  });

  const movieId = at(films.itemIds, 0);
  const showId = at(films.itemIds, 1);
  const episodeId = at(at(films.episodeIds, 1), 0);
  const siblingId = at(at(films.episodeIds, 1), 1);
  const fileId = at(films.fileIds, 0);
  const played = await maker.signedIn.client.mutation(api.movies.play.start, { titleId: movieId });
  await insertByHand(core, "mediaFiles", [
    {
      libraryId: films.libraryId,
      titleId: movieId,
      episodeId: null,
      path: `/probe/${films.libraryId}/second.mkv`,
      sizeBytes: 2000,
      mtimeMs: 0,
      probe: played.file.probe,
      externalSubtitles: [],
      versionName: "Second",
      hdr: false,
      missing: false,
      addedAt: Date.now(),
      sidecarDigest: null,
    },
  ]);
  await insertByHand(
    core,
    "seasons",
    [2, 3].map((seasonNumber) => ({
      titleId: showId,
      seasonNumber,
      name: `Season ${seasonNumber}`,
      poster: "a1.c2Vhc29u",
      episodeCount: 0,
      externalIds: { tmdb: null, imdb: null, tvdb: null },
    })),
  );
  await patchByHand(core, "titles", [movieId, showId], {
    artwork: { poster: "a1.cG9zdGVy", backdrop: "a1.YmFja2Ryb3A", logo: null },
    year: 2020,
    runtimeMs: 60_000,
    overview: "Scanned summary",
    certification: "PG",
    overrides: { year: 2021, overview: "Shared summary", certification: "PG-13" },
  });
  await patchByHand(core, "episodes", [episodeId], { still: "a1.c3RpbGw" });

  const songs = await seedLibrary(core, maker, {
    name: unique(),
    kind: "music",
    items: [
      onAlbum("Shared Album", "First"),
      onAlbum("Shared Album", "Second"),
      onAlbum("Shared Album", "Third"),
      onAlbum("Other Album", "Other"),
    ],
  });

  const trackId = at(songs.itemIds, 0);
  const otherTrackId = at(songs.itemIds, 3);
  const track = await maker.signedIn.client.query(api.music.tracks.get, { trackId });

  const otherTrack = await maker.signedIn.client.query(api.music.tracks.get, {
    trackId: otherTrackId,
  });

  await patchByHand(core, "tracks", songs.itemIds, { artHash: "test-art" });
  await patchByHand(core, "albums", [track.albumId], { artHash: "test-art" });

  return {
    admin,
    maker,
    films,
    songs,
    movieId,
    showId,
    episodeId,
    siblingId,
    fileId,
    trackId,
    otherTrackId,
    albumId: track.albumId,
    otherAlbumId: otherTrack.albumId,
  };
};

type Shelf = Awaited<ReturnType<typeof seed>>;

type MovieItem = FunctionArgs<typeof api.movies.playback.get>["item"];

type MusicItem = FunctionArgs<typeof api.music.playback.get>["item"];

const movieItem = (shelf: Shelf, kind: "movie" | "show" | "episode" | "file"): MovieItem => {
  switch (kind) {
    case "movie":
      return { type: "title", id: shelf.movieId };
    case "show":
      return { type: "title", id: shelf.showId };
    case "episode":
      return { type: "episode", id: shelf.episodeId };
    case "file":
      return { type: "file", id: shelf.fileId };
    default: {
      const exhaustive: never = kind;

      return exhaustive;
    }
  }
};

const musicItem = (shelf: Shelf, kind: "track" | "album"): MusicItem =>
  kind === "track" ? { type: "track", id: shelf.trackId } : { type: "album", id: shelf.albumId };

const catalogRefusals = async (who: Session, shelf: Shelf) => {
  const client = who.signedIn.client;

  const queries = [
    client.query(api.movies.titles.list, { paginationOpts: page }),
    client.query(api.movies.titles.search, { query: "Shared" }),
    client.query(api.movies.titles.home, {}),
    client.query(api.movies.titles.genres, {}),
    client.query(api.movies.people.search, { query: "Shared" }),
    client.query(api.movies.collections.list, { paginationOpts: page }),
    client.query(api.movies.myList.list, { paginationOpts: page }),
    client.query(api.movies.history.list, { paginationOpts: page }),
    client.query(api.movies.history.continueWatching, {}),
    client.query(api.movies.files.list, { libraryId: shelf.films.libraryId, paginationOpts: page }),
    client.query(api.movies.titles.get, { titleId: shelf.movieId }),
    client.query(api.movies.titles.versions, { titleId: shelf.movieId }),
    client.query(api.movies.titles.episodes, {
      titleId: shelf.showId,
      seasonNumber: 1,
      paginationOpts: page,
    }),
    client.query(api.movies.titles.nextEpisode, { episodeId: shelf.episodeId }),
    client.query(api.movies.titles.similar, { titleId: shelf.movieId }),
    client.query(api.music.tracks.list, { paginationOpts: page }),
    client.query(api.music.albums.list, { paginationOpts: page }),
    client.query(api.music.artists.list, { paginationOpts: page }),
    client.query(api.music.library.search, { query: "Shared" }),
    client.query(api.music.library.home, {}),
    client.query(api.music.playlists.list, { paginationOpts: page }),
    client.query(api.music.playlists.shared, { paginationOpts: page }),
    client.query(api.music.likes.list, { paginationOpts: page }),
    client.query(api.music.history.list, { paginationOpts: page }),
    client.query(api.music.tracks.get, { trackId: shelf.trackId }),
    client.query(api.music.albums.get, { albumId: shelf.albumId }),
    client.query(api.music.albums.tracks, { albumId: shelf.albumId, paginationOpts: page }),
  ];

  expect(await Promise.all(queries.map(async (query) => refusal(query)))).toEqual(
    queries.map(() => "forbidden"),
  );
};

describe.skipIf(stack === undefined)(
  "playback details through guest sessions",
  { timeout: 180_000 },
  () => {
    let shelf: Shelf;
    beforeAll(async () => {
      if (stack !== undefined) shelf = await seed(stack);
    });

    it.each(["movie", "show", "episode", "file"] as const)("contains a %s link", async (kind) => {
      if (stack === undefined) return;
      const item = movieItem(shelf, kind);

      const link = await makeLink(shelf.maker, {
        kind: "item",
        item: { domain: "movies", ref: item },
      });

      const guest = await openLink(stack, link.code, "Viewer");
      const client = guest.signedIn.client;
      const detail = await client.query(api.movies.playback.get, { item });
      expect(detail.name).toBe(
        kind === "movie" || kind === "file" ? "Shared Movie" : "Shared Show",
      );
      expect(detail).toMatchObject({
        year: 2021,
        runtimeMs: 60_000,
        overview: "Shared summary",
        certification: "PG-13",
      });
      expect(detail.artwork.poster).toMatch(/^\/artwork\/a1\..*\?ticket=t1\./u);
      expect(Object.keys(detail).toSorted()).toEqual(
        [
          "titleId",
          "kind",
          "name",
          "year",
          "overview",
          "runtimeMs",
          "certification",
          "artwork",
          "episode",
          "versions",
        ].toSorted(),
      );
      expect(detail.versions).toHaveLength({ movie: 2, show: 0, episode: 1, file: 1 }[kind]);
      await Promise.all(
        detail.versions.map(async (version) => {
          const playArgs: FunctionArgs<typeof api.movies.play.start> = {
            titleId: detail.titleId,
            fileId: version.id,
          };

          if (detail.episode !== null) playArgs.episodeId = detail.episode.id;

          expect(await refusal(client.mutation(api.movies.play.start, playArgs))).toBe("accepted");
        }),
      );
      expect(
        await refusal(
          client.query(api.movies.playback.get, {
            item: { type: "title", id: at(shelf.films.itemIds, 2) },
          }),
        ),
      ).toBe("not_found");
      expect(
        await refusal(
          client.query(api.music.playback.get, { item: { type: "track", id: shelf.trackId } }),
        ),
      ).toBe("not_found");

      if (kind === "show") {
        const seasons = await allPages((cursor) =>
          client.query(api.movies.playback.seasons, {
            titleId: shelf.showId,
            paginationOpts: { numItems: 1, cursor },
          }),
        );

        expect(seasons.rows.map((row) => row.seasonNumber)).toEqual([1, 2, 3]);
        expect(seasons.calls).toBeGreaterThan(1);
        expect(at(seasons.rows, 1).poster).toMatch(/\?ticket=t1\./u);

        const episodes = await allPages((cursor) =>
          client.query(api.movies.playback.episodes, {
            titleId: shelf.showId,
            seasonNumber: 1,
            paginationOpts: { numItems: 1, cursor },
          }),
        );

        expect(episodes.rows.map((row) => row.id)).toEqual(at(shelf.films.episodeIds, 1));
        expect(episodes.calls).toBeGreaterThan(1);

        await Promise.all(
          episodes.rows.map(async (row) => {
            expect(
              (
                await client.query(api.movies.playback.get, {
                  item: { type: "episode", id: row.id },
                })
              ).versions,
            ).toHaveLength(1);
          }),
        );
      } else {
        expect(
          await refusal(
            client.query(api.movies.playback.seasons, {
              titleId: shelf.showId,
              paginationOpts: page,
            }),
          ),
        ).toBe("not_found");
        expect(
          await refusal(
            client.query(api.movies.playback.episodes, {
              titleId: shelf.showId,
              seasonNumber: 1,
              paginationOpts: page,
            }),
          ),
        ).toBe("not_found");
        expect(
          await refusal(
            client.query(api.movies.playback.get, {
              item: { type: "episode", id: shelf.siblingId },
            }),
          ),
        ).toBe("not_found");
      }

      if (kind === "episode") {
        expect(detail.episode?.still).toMatch(/\?ticket=t1\./u);
        expect(
          await refusal(
            client.query(api.movies.playback.get, { item: { type: "title", id: shelf.showId } }),
          ),
        ).toBe("not_found");
      }

      if (kind === "file") {
        const allVersions = await shelf.maker.signedIn.client.query(api.movies.playback.get, {
          item: { type: "title", id: shelf.movieId },
        });

        const otherVersion = allVersions.versions.find((version) => version.id !== shelf.fileId);

        if (otherVersion === undefined) throw new Error("No alternate version");
        expect(
          await refusal(
            client.query(api.movies.playback.get, {
              item: { type: "file", id: otherVersion.id },
            }),
          ),
        ).toBe("not_found");
        expect(detail.versions.map((row) => row.id)).toEqual([shelf.fileId]);
        expect(
          await refusal(
            client.query(api.movies.playback.get, { item: { type: "title", id: shelf.movieId } }),
          ),
        ).toBe("not_found");
      }

      await catalogRefusals(guest, shelf);
      await patchByHand(stack, "shareLinks", [link.linkId], { expiresAt: Date.now() - 1000 });
      expect(await refusal(client.query(api.movies.playback.get, { item }))).toBe(
        "unauthenticated",
      );
      expect(
        await refusal(
          client.query(api.movies.playback.seasons, {
            titleId: shelf.showId,
            paginationOpts: page,
          }),
        ),
      ).toBe("unauthenticated");
      expect(
        await refusal(
          client.query(api.movies.playback.episodes, {
            titleId: shelf.showId,
            seasonNumber: 1,
            paginationOpts: page,
          }),
        ),
      ).toBe("unauthenticated");

      const renewed = await makeLink(shelf.maker, {
        kind: "item",
        item: { domain: "movies", ref: item },
      });

      const revoked = await openLink(stack, renewed.code, "Viewer");
      await shelf.maker.signedIn.client.mutation(api.core.guests.links.revoke, {
        linkId: renewed.linkId,
      });
      expect(await refusal(revoked.signedIn.client.query(api.movies.playback.get, { item }))).toBe(
        "unauthenticated",
      );
      expect(
        await refusal(
          revoked.signedIn.client.query(api.movies.playback.seasons, {
            titleId: shelf.showId,
            paginationOpts: page,
          }),
        ),
      ).toBe("unauthenticated");
      expect(
        await refusal(
          revoked.signedIn.client.query(api.movies.playback.episodes, {
            titleId: shelf.showId,
            seasonNumber: 1,
            paginationOpts: page,
          }),
        ),
      ).toBe("unauthenticated");
    });

    it.each(["track", "album"] as const)("contains a %s link", async (kind) => {
      if (stack === undefined) return;
      const item = musicItem(shelf, kind);

      const link = await makeLink(shelf.maker, {
        kind: "item",
        item: { domain: "music", ref: item },
      });

      const guest = await openLink(stack, link.code, "Listener");
      const client = guest.signedIn.client;
      const detail = await client.query(api.music.playback.get, { item });
      expect(detail.kind).toBe(kind);
      expect(detail.artUrl).toMatch(/^\/music\/art\/test-art\?ticket=t1\./u);
      expect(detail).not.toHaveProperty("artistId");
      expect(detail).not.toHaveProperty("albumId");
      expect(
        await refusal(
          client.query(api.music.playback.get, { item: { type: "track", id: shelf.otherTrackId } }),
        ),
      ).toBe("not_found");
      expect(
        await refusal(
          client.query(api.music.playback.get, { item: { type: "album", id: shelf.otherAlbumId } }),
        ),
      ).toBe("not_found");
      expect(
        await refusal(
          client.query(api.music.playback.tracks, {
            albumId: shelf.otherAlbumId,
            paginationOpts: page,
          }),
        ),
      ).toBe("not_found");
      expect(
        await refusal(
          client.query(api.movies.playback.get, { item: { type: "title", id: shelf.movieId } }),
        ),
      ).toBe("not_found");

      if (kind === "album") {
        const songs = await allPages((cursor) =>
          client.query(api.music.playback.tracks, {
            albumId: shelf.albumId,
            paginationOpts: { numItems: 1, cursor },
          }),
        );

        expect(songs.rows.map((row) => row.id).toSorted()).toEqual(
          shelf.songs.itemIds.slice(0, 3).toSorted(),
        );
        expect(songs.calls).toBeGreaterThan(1);
        await Promise.all(
          songs.rows.map(async (row) => {
            expect(
              (await client.query(api.music.playback.get, { item: { type: "track", id: row.id } }))
                .id,
            ).toBe(row.id);
            expect(await refusal(client.mutation(api.music.play.start, { trackId: row.id }))).toBe(
              "accepted",
            );
          }),
        );
      } else {
        expect(
          await refusal(
            client.query(api.music.playback.get, { item: { type: "album", id: shelf.albumId } }),
          ),
        ).toBe("not_found");
        expect(
          await refusal(
            client.query(api.music.playback.tracks, {
              albumId: shelf.albumId,
              paginationOpts: page,
            }),
          ),
        ).toBe("not_found");
        expect(
          await refusal(
            client.query(api.music.playback.get, {
              item: { type: "track", id: at(shelf.songs.itemIds, 1) },
            }),
          ),
        ).toBe("not_found");
      }

      await catalogRefusals(guest, shelf);
      await patchByHand(stack, "shareLinks", [link.linkId], { expiresAt: Date.now() - 1000 });
      expect(await refusal(client.query(api.music.playback.get, { item }))).toBe("unauthenticated");
      expect(
        await refusal(
          client.query(api.music.playback.tracks, { albumId: shelf.albumId, paginationOpts: page }),
        ),
      ).toBe("unauthenticated");

      const renewed = await makeLink(shelf.maker, {
        kind: "item",
        item: { domain: "music", ref: item },
      });

      const revoked = await openLink(stack, renewed.code, "Listener");
      await shelf.maker.signedIn.client.mutation(api.core.guests.links.revoke, {
        linkId: renewed.linkId,
      });
      expect(await refusal(revoked.signedIn.client.query(api.music.playback.get, { item }))).toBe(
        "unauthenticated",
      );
      expect(
        await refusal(
          revoked.signedIn.client.query(api.music.playback.tracks, {
            albumId: shelf.albumId,
            paginationOpts: page,
          }),
        ),
      ).toBe("unauthenticated");
    });
    it("drops a song the maker loses, keeps pagination through an empty page, and refuses a missing song", async () => {
      if (stack === undefined) return;

      const inaccessible = await seedLibrary(stack, shelf.admin, {
        name: unique(),
        kind: "music",
        items: [onAlbum("Private", "Hidden")],
      });

      const item = { type: "album", id: shelf.albumId } as const;

      const link = await makeLink(shelf.maker, {
        kind: "item",
        item: { domain: "music", ref: item },
      });

      const guest = await openLink(stack, link.code, "Listener");
      const client = guest.signedIn.client;

      const before = await allPages((cursor) =>
        client.query(api.music.playback.tracks, {
          albumId: shelf.albumId,
          paginationOpts: { numItems: 1, cursor },
        }),
      );

      const lost = at(before.rows, 0).id;
      await patchByHand(stack, "tracks", [lost], { libraryId: inaccessible.libraryId });

      try {
        expect(
          await refusal(
            shelf.maker.signedIn.client.mutation(api.music.play.start, { trackId: lost }),
          ),
        ).toBe("not_found");
        expect(
          await refusal(
            client.query(api.music.playback.get, { item: { type: "track", id: lost } }),
          ),
        ).toBe("not_found");
        expect(await refusal(client.mutation(api.music.play.start, { trackId: lost }))).toBe(
          "not_found",
        );

        const first = await client.query(api.music.playback.tracks, {
          albumId: shelf.albumId,
          paginationOpts: { numItems: 1, cursor: null },
        });

        expect(first.page).toEqual([]);
        expect(first.isDone).toBe(false);

        const remaining = await allPages((cursor) =>
          client.query(api.music.playback.tracks, {
            albumId: shelf.albumId,
            paginationOpts: { numItems: 1, cursor },
          }),
        );

        expect(remaining.rows.map((row) => row.id)).toEqual(
          before.rows.slice(1).map((row) => row.id),
        );
        const missing = at(remaining.rows, 0).id;
        await patchByHand(stack, "tracks", [missing], { missing: true });

        try {
          expect(
            await refusal(
              client.query(api.music.playback.get, { item: { type: "track", id: missing } }),
            ),
          ).toBe("not_found");

          const available = await allPages((cursor) =>
            client.query(api.music.playback.tracks, {
              albumId: shelf.albumId,
              paginationOpts: { numItems: 1, cursor },
            }),
          );

          expect(available.rows.map((row) => row.id)).toEqual(
            remaining.rows.slice(1).map((row) => row.id),
          );
        } finally {
          await patchByHand(stack, "tracks", [missing], { missing: false });
        }
      } finally {
        await patchByHand(stack, "tracks", [lost], { libraryId: shelf.songs.libraryId });
      }
    });

    it("answers household callers only when they may play the item", async () => {
      if (stack === undefined) return;
      const stranger = await member(stack, "detail-stranger");
      const client = shelf.maker.signedIn.client;

      const started = await client.mutation(api.movies.play.start, {
        titleId: shelf.movieId,
        fileId: shelf.fileId,
      });

      await client.mutation(api.movies.play.report, {
        fileId: shelf.fileId,
        positionMs: 100,
        durationMs: 60_000,
        event: "pause",
        playbackId: started.playbackId,
        startedAt: started.startedAt,
      });

      const detail = await client.query(api.movies.playback.get, {
        item: { type: "title", id: shelf.movieId },
      });

      expect(
        detail.versions.filter((version) => version.lastPlayed).map((version) => version.id),
      ).toEqual([shelf.fileId]);

      await Promise.all(
        (["movie", "show", "episode", "file"] as const).map(async (kind) => {
          const item = movieItem(shelf, kind);
          expect(
            await refusal(shelf.maker.signedIn.client.query(api.movies.playback.get, { item })),
          ).toBe("accepted");
          expect(
            await refusal(stranger.signedIn.client.query(api.movies.playback.get, { item })),
          ).toBe("not_found");
        }),
      );
      await Promise.all(
        (["track", "album"] as const).map(async (kind) => {
          const item = musicItem(shelf, kind);
          expect(
            await refusal(shelf.maker.signedIn.client.query(api.music.playback.get, { item })),
          ).toBe("accepted");
          expect(
            await refusal(stranger.signedIn.client.query(api.music.playback.get, { item })),
          ).toBe("not_found");
        }),
      );
      expect(
        await refusal(
          stranger.signedIn.client.query(api.movies.playback.seasons, {
            titleId: shelf.showId,
            paginationOpts: page,
          }),
        ),
      ).toBe("not_found");
      expect(
        await refusal(
          stranger.signedIn.client.query(api.movies.playback.episodes, {
            titleId: shelf.showId,
            seasonNumber: 1,
            paginationOpts: page,
          }),
        ),
      ).toBe("not_found");
      expect(
        await refusal(
          stranger.signedIn.client.query(api.music.playback.tracks, {
            albumId: shelf.albumId,
            paginationOpts: page,
          }),
        ),
      ).toBe("not_found");
    });
  },
);
