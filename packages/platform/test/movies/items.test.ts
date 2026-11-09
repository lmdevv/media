import { makeFunctionReference } from "convex/server";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { DomainItem, Restrictions } from "../../commands/access";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { runFunction } from "../admin";
import { enroll, member, sharedAdmin } from "../devices";
import type { Member } from "../devices";
import { movie, seedLibrary, share, show, song, unshare } from "../probe";
import type { SeededMoviesLibrary } from "../probe";
import { refusal, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";

const stack = coreStackFromEnvFile();

const Issued = Schema.Struct({ ticket: Schema.String, expiresAt: Schema.Finite });

const NONE: Restrictions = {
  maxMovieAge: null,
  hideUnrated: false,
  hideExplicitMusic: false,
  libraries: null,
};

const title = (id: Id<"titles">): DomainItem => ({ domain: "movies", ref: { type: "title", id } });

const episode = (id: Id<"episodes">): DomainItem => ({
  domain: "movies",
  ref: { type: "episode", id },
});

const file = (id: Id<"mediaFiles">): DomainItem => ({
  domain: "movies",
  ref: { type: "file", id },
});

/** `core.together.add` as a client that does not use the generated types sends it. */
const untypedAdd = makeFunctionReference<
  "mutation",
  { item: { domain: string; ref: { type: string; id: string } } },
  unknown
>("core/together:add");

const play = (core: CoreStack, who: Member, item: DomainItem) =>
  runFunction(core, internal.core.ticketsProbe.play, { sessionId: who.sessionId, item }, Issued);

const playable = async (core: CoreStack, who: Member, item: DomainItem): Promise<boolean> => {
  const answer = await refusal(play(core, who, item));

  if (answer !== "accepted" && answer !== "not_found") throw new Error(`play answered ${answer}`);

  return answer === "accepted";
};

const at = <T>(values: ReadonlyArray<T>, index: number): T => {
  const value = values[index];

  if (value === undefined) throw new Error(`seeded nothing at ${index}`);

  return value;
};

/** G, PG, R, unrated movies, and a PG show of two episodes, in one library shared with `kid`. */
const ratedShelf = async (
  core: CoreStack,
  kid: Member,
): Promise<{ readonly films: SeededMoviesLibrary; readonly manager: Member }> => {
  const manager = await member(core, "rated-manager");

  const films = await seedLibrary(core, manager, {
    name: `rated-${unique()}`,
    kind: "movies",
    items: [
      movie("G", 0),
      movie("PG", 7),
      movie("R", 17),
      movie("Unrated", null),
      show("PG show", 7, 2),
      show("R show", 17, 1),
    ],
  });

  await share(manager, films.libraryId, { kind: "user", userId: kid.userId }, "view");

  return { films, manager };
};

describe.skipIf(stack === undefined)("movies items", { timeout: 120_000 }, () => {
  it("decide titles, episodes, and files through can() from the title's rating", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const kid = await member(stack, "rated-kid");
    const { films } = await ratedShelf(stack, kid);
    const titles = films.itemIds.map((id) => title(id));
    const pgEpisode = episode(at(at(films.episodeIds, 4), 0));
    const rEpisode = episode(at(at(films.episodeIds, 5), 0));
    const rFile = file(at(films.fileIds, 2));
    const pgFile = file(at(films.fileIds, 1));

    const decide = async () =>
      Promise.all(
        [...titles, pgEpisode, rEpisode, pgFile, rFile].map(async (item) =>
          playable(stack, kid, item),
        ),
      );

    expect(await decide()).toEqual([true, true, true, true, true, true, true, true, true, true]);

    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: kid.userId,
      restrictions: { ...NONE, maxMovieAge: 7 },
    });

    expect(await decide()).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);

    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: kid.userId,
      restrictions: { ...NONE, maxMovieAge: 7, hideUnrated: true },
    });

    expect(await decide()).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("let a group session hold titles, episodes, and files, and refuse a track in it", async () => {
    if (stack === undefined) return;
    const host = await member(stack, "typed-host");

    const films = await seedLibrary(stack, host, {
      name: `typed-${unique()}`,
      kind: "movies",
      items: [movie("Sintel", 0), show("Pioneer One", 0, 1)],
    });

    const songs = await seedLibrary(stack, host, {
      name: `typed-songs-${unique()}`,
      kind: "music",
      items: [song("track", false)],
    });

    await host.signedIn.client.action(api.core.together.create, {
      item: title(at(films.itemIds, 0)),
    });
    await host.signedIn.client.mutation(api.core.together.add, {
      item: episode(at(at(films.episodeIds, 1), 0)),
    });
    await host.signedIn.client.mutation(api.core.together.add, {
      item: file(at(films.fileIds, 0)),
    });

    const track: DomainItem = {
      domain: "music",
      ref: { type: "probeTrack", id: at(songs.itemIds, 0) },
    };

    const crossed = { domain: "movies", ref: { type: "probeTrack", id: at(songs.itemIds, 0) } };

    expect(await refusal(host.signedIn.client.mutation(untypedAdd, { item: crossed }))).toMatch(
      /ArgumentValidationError/u,
    );
    expect(
      await refusal(host.signedIn.client.mutation(api.core.together.add, { item: track })),
    ).toBe("not_found");
  });

  it("expire a kept movies file once its keeper loses access", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko-keeps");
    const kid = await member(stack, "keeps-kid");
    const { films, manager } = await ratedShelf(stack, kid);

    await share(manager, films.libraryId, { kind: "user", userId: aiko.userId }, "view");
    await enroll(aiko.signedIn, "Phone");

    const kept = at(films.fileIds, 0);

    await aiko.signedIn.client.mutation(api.core.downloads.add, {
      item: { kind: "file", id: kept },
    });

    const stateOf = async () =>
      (
        await aiko.signedIn.client.query(api.core.downloads.list, {
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((entry) => (entry.state === "expired" ? `expired:${entry.because}` : entry.state));

    expect(await stateOf()).toEqual(["available"]);

    await unshare(manager, films.libraryId, { kind: "user", userId: aiko.userId });

    expect(await stateOf()).toEqual(["expired:access"]);
  });
});
