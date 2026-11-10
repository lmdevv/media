import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import { runFunction } from "../admin";
import { member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  claimJob,
  finishJob,
  markMissing,
  moviesLibrary,
  setFoldersQuietly,
  upsert,
} from "./catalog";
import { movieFile } from "./scanned";

const stack = coreStackFromEnvFile();

const Resolved = Schema.NullOr(
  Schema.Struct({
    fileId: Schema.String,
    libraryId: Schema.String,
    path: Schema.String,
    roots: Schema.Array(Schema.String),
    probe: Schema.Struct({ container: Schema.String, durationMs: Schema.Finite }),
    externalSubtitles: Schema.Array(Schema.Unknown),
    missing: Schema.Boolean,
  }),
);

const resolve = (core: CoreStack, fileId: string) =>
  runServer(core, api.movies.files.resolveFile, { fileId }, Resolved);

describe.skipIf(stack === undefined)("movies/files:resolveFile", { timeout: 180_000 }, () => {
  it("answers a live file, and null for a missing one, a purging title, and an unknown id", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "resolve-admin", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Resolved", 2);
    const [root, other] = roots;

    if (root === undefined || other === undefined) throw new Error("made too few folders");

    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const paths = ["live.mkv", "gone.mkv", "purging.mkv"].map((name) => join(root, name));

    const landed = await upsert(
      stack,
      lease,
      paths.map((path) => movieFile(path)),
    );

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    const [live, gone, purging] = landed.value.files;

    if (live === undefined || gone === undefined || purging === undefined) {
      throw new Error("too few files landed");
    }

    await markMissing(stack, lease, [gone.path]);
    await finishJob(stack, lease);
    await runFunction(
      stack,
      internal.movies.probe.markPurging,
      { titleId: purging.titleId },
      Schema.Null,
    );

    expect(await resolve(stack, live.fileId)).toEqual({
      fileId: live.fileId,
      libraryId,
      path: live.path,
      roots: [...roots].toSorted(),
      probe: { container: "matroska", durationMs: 0 },
      externalSubtitles: [],
      missing: false,
    });
    expect(await resolve(stack, gone.fileId)).toBeNull();
    expect(await resolve(stack, purging.fileId)).toBeNull();
    expect(await resolve(stack, "not-an-id")).toBeNull();
    expect(await resolve(stack, libraryId)).toBeNull();
    expect(
      await refusal(
        runServerAs(
          stack,
          admin.signedIn,
          api.movies.files.resolveFile,
          { fileId: live.fileId },
          Resolved,
        ),
      ),
    ).toBe("forbidden");

    // A folder taken out of the library hides its files before its purge reaches them.
    await setFoldersQuietly(stack, libraryId, [other]);
    expect(await resolve(stack, live.fileId)).toBeNull();
    await setFoldersQuietly(stack, libraryId, [...roots]);
    expect(await resolve(stack, live.fileId)).not.toBeNull();

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
    expect(await resolve(stack, live.fileId)).toBeNull();
  });
});
