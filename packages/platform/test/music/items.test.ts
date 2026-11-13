import { makeFunctionReference } from "convex/server";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { DomainItem, Restrictions } from "../../commands/access";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { runFunction } from "../admin";
import { enroll, member, sharedAdmin } from "../devices";
import type { Member } from "../devices";
import { movie, openItem, seedLibrary, share, song, unshare, visibleItems } from "../probe";
import { refusal, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  claimScan,
  finishScan,
  markMissing,
  musicLibrary,
  trackIdsAt,
  trackState,
  upsert,
} from "./catalog";
import { musicTrack } from "./scanned";

const stack = coreStackFromEnvFile();

const Issued = Schema.Struct({ ticket: Schema.String, expiresAt: Schema.Finite });

const EXPLICIT_FILTER: Restrictions = {
  maxMovieAge: null,
  hideUnrated: false,
  hideExplicitMusic: true,
  libraries: null,
};

const track = (id: Id<"tracks">): DomainItem => ({ domain: "music", ref: { type: "track", id } });

const album = (id: Id<"albums">): DomainItem => ({ domain: "music", ref: { type: "album", id } });

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

  if (value === undefined) throw new Error(`no value at ${index}`);

  return value;
};

/** A music library of two explicit songs and a clean one, shared with `viewers`. */
const explicitShelf = async (core: CoreStack, viewers: ReadonlyArray<Member>) => {
  const manager = await member(core, "music-manager");

  const songs = await seedLibrary(core, manager, {
    name: `explicit-${unique()}`,
    kind: "music",
    items: [song("Loud", true), song("Louder", true), song("Quiet", false)],
  });

  await Promise.all(
    viewers.map(async (viewer) =>
      share(manager, songs.libraryId, { kind: "user", userId: viewer.userId }, "view"),
    ),
  );

  return { manager, songs };
};

describe.skipIf(stack === undefined)("music items", { timeout: 120_000 }, () => {
  it("hide explicit tracks from a kid with the explicit filter on, and from no one else", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const kid = await member(stack, "explicit-kid");
    const aiko = await member(stack, "explicit-aiko");

    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: kid.userId,
      restrictions: EXPLICIT_FILTER,
    });

    const { songs } = await explicitShelf(stack, [kid, aiko]);
    const [loud, louder, quiet] = [0, 1, 2].map((n) => at(songs.itemIds, n));

    if (loud === undefined || louder === undefined || quiet === undefined) throw new Error("seed");

    expect(await playable(stack, kid, track(loud))).toBe(false);
    expect(await playable(stack, kid, track(louder))).toBe(false);
    expect(await playable(stack, kid, track(quiet))).toBe(true);
    expect(await playable(stack, aiko, track(loud))).toBe(true);
    expect(await playable(stack, aiko, track(louder))).toBe(true);

    expect(await refusal(openItem(stack, kid, loud))).toBe("not_found");
    expect((await openItem(stack, aiko, loud)).level).toBe("view");
    expect(await visibleItems(stack, kid, songs.libraryId)).toEqual([quiet]);
    expect(new Set(await visibleItems(stack, aiko, songs.libraryId))).toEqual(
      new Set([loud, louder, quiet]),
    );
  });

  it("place an album in its library, never explicit itself", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const kid = await member(stack, "album-kid");
    const sam = await member(stack, "album-sam");

    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: kid.userId,
      restrictions: EXPLICIT_FILTER,
    });

    const { songs } = await explicitShelf(stack, [kid]);
    const state = await trackState(stack, at(songs.itemIds, 0));

    if (state === null) throw new Error("seeded no track");

    expect(await playable(stack, kid, album(state.albumId))).toBe(true);
    expect(await playable(stack, sam, album(state.albumId))).toBe(false);
  });

  it("type a music session's items, refusing a movies title by its type and argument", async () => {
    if (stack === undefined) return;
    const host = await member(stack, "music-host");

    const songs = await seedLibrary(stack, host, {
      name: `typed-${unique()}`,
      kind: "music",
      items: [song("First", false), song("Second", false)],
    });

    const films = await seedLibrary(stack, host, {
      name: `typed-films-${unique()}`,
      kind: "movies",
      items: [movie("Sintel", 0)],
    });

    await host.signedIn.client.action(api.core.together.create, {
      item: track(at(songs.itemIds, 0)),
    });

    const added = await host.signedIn.client.mutation(api.core.together.add, {
      item: track(at(songs.itemIds, 1)),
    });

    expect(added.entryId.length).toBeGreaterThan(0);

    const titleId = at(films.itemIds, 0);
    const misfiled = { domain: "music", ref: { type: "title", id: titleId } };
    const mistyped = { domain: "music", ref: { type: "track", id: titleId } };

    expect(await refusal(host.signedIn.client.mutation(untypedAdd, { item: misfiled }))).toMatch(
      /ArgumentValidationError/u,
    );
    expect(await refusal(host.signedIn.client.mutation(untypedAdd, { item: mistyped }))).toMatch(
      /ArgumentValidationError/u,
    );
  });

  it("expire a kept track once its keeper loses access", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko-keeps-track");
    const { manager, songs } = await explicitShelf(stack, [aiko]);

    await enroll(aiko.signedIn, "Phone");
    await aiko.signedIn.client.mutation(api.core.downloads.add, {
      item: { kind: "track", id: at(songs.itemIds, 2) },
    });

    const stateOf = async () =>
      (
        await aiko.signedIn.client.query(api.core.downloads.list, {
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((entry) => (entry.state === "expired" ? `expired:${entry.because}` : entry.state));

    expect(await stateOf()).toEqual(["available"]);

    const fetched = await aiko.signedIn.client.mutation(api.core.downloads.fetch, {
      item: { kind: "track", id: at(songs.itemIds, 2) },
    });

    expect(fetched.state).toBe("available");
    expect(fetched.state === "available" ? fetched.resource : null).toEqual({
      kind: "track",
      id: at(songs.itemIds, 2),
    });

    await unshare(manager, songs.libraryId, { kind: "user", userId: aiko.userId });

    expect(await stateOf()).toEqual(["expired:access"]);
  });

  it("show a kept track gone while a scan finds it missing, and available once it returns", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "kept-admin", "admin");
    const aiko = await member(stack, "aiko-kept-missing");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Kept");

    await share(admin, libraryId, { kind: "user", userId: aiko.userId }, "view");

    const lease = await claimScan(stack, scanJobId);
    const scanned = musicTrack(`${at(roots, 0)}/Album/song.flac`, 4000, 1);

    expect(await upsert(stack, lease, [scanned])).toMatchObject({ value: { done: 1 } });

    const [keptId] = await trackIdsAt(stack, libraryId, [scanned.path]);

    if (keptId === undefined || keptId === null) throw new Error("the scan wrote no track");

    await enroll(aiko.signedIn, "Phone");
    await aiko.signedIn.client.mutation(api.core.downloads.add, {
      item: { kind: "track", id: keptId },
    });

    const stateOf = async () =>
      (
        await aiko.signedIn.client.query(api.core.downloads.list, {
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((entry) =>
        entry.state === "available" ? `available:${entry.revision}:${entry.bytes}` : entry.state,
      );

    expect(await stateOf()).toEqual([`available:${(4000).toString(36)}-1:4000`]);
    expect(await markMissing(stack, lease, [scanned.path])).toMatchObject({
      value: { marked: 1 },
    });
    expect(await stateOf()).toEqual(["gone"]);
    expect(await upsert(stack, lease, [scanned])).toMatchObject({ value: { done: 1 } });
    expect(await stateOf()).toEqual([`available:${(4000).toString(36)}-1:4000`]);

    await finishScan(stack, lease);
  });
});
