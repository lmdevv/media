import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import {
  claimScan,
  finishScan,
  markMissingAll,
  musicLibrary,
  setFoldersQuietly,
  trackIdsAt,
  upsertAll,
} from "./catalog";
import { musicTrack } from "./scanned";

const stack = coreStackFromEnvFile();

const Resolved = Schema.NullOr(
  Schema.Struct({
    trackId: Schema.String,
    libraryId: Schema.String,
    path: Schema.String,
    roots: Schema.Array(Schema.String),
    size: Schema.Finite,
    mtimeMs: Schema.Finite,
    codec: Schema.String,
  }),
);

describe.skipIf(stack === undefined)("music track resolve", { timeout: 180_000 }, () => {
  it("answer a track's file to the server only, and null once it is missing or outside its folders", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "resolve-admin", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Resolve", 2);
    const [first = "", second = ""] = roots;
    const lease = await claimScan(stack, scanJobId);
    const kept = `${first}/Artist/Album/01 Kept.flac`;
    const gone = `${first}/Artist/Album/02 Gone.mp3`;
    const moved = `${second}/Artist/Other/01 Moved.flac`;

    await upsertAll(stack, lease, [
      musicTrack(kept, 4321, 1_700_000_000_123.5),
      musicTrack(gone, 99, 1, { codec: "mp3", lossless: false }),
      musicTrack(moved, 100, 2),
    ]);

    const [keptId, goneId, movedId] = await trackIdsAt(stack, libraryId, [kept, gone, moved]);

    if (keptId === null || keptId === undefined) throw new Error("no kept track");

    expect(await runServer(stack, api.music.tracks.resolve, { trackId: keptId }, Resolved)).toEqual(
      {
        trackId: keptId,
        libraryId,
        path: kept,
        roots: [...roots].toSorted(),
        size: 4321,
        mtimeMs: 1_700_000_000_123.5,
        codec: "flac",
      },
    );

    expect(
      await refusal(
        runServerAs(stack, admin.signedIn, api.music.tracks.resolve, { trackId: keptId }, Resolved),
      ),
    ).toBe("forbidden");

    await markMissingAll(stack, lease, [gone]);
    await finishScan(stack, lease);

    expect(
      await runServer(stack, api.music.tracks.resolve, { trackId: goneId ?? "" }, Resolved),
    ).toBeNull();
    expect(
      await runServer(stack, api.music.tracks.resolve, { trackId: "not-an-id" }, Resolved),
    ).toBeNull();

    // A removed folder's tracks stay until the purge reaches them, but are no longer served.
    await setFoldersQuietly(stack, libraryId, [first]);

    expect(
      await runServer(stack, api.music.tracks.resolve, { trackId: movedId ?? "" }, Resolved),
    ).toBeNull();
    expect(
      (await runServer(stack, api.music.tracks.resolve, { trackId: keptId }, Resolved))?.roots,
    ).toEqual([first]);
  });
});
