import { assert, describe, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem } from "effect";
import { HttpClient } from "effect/http";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";

const hasFfmpeg = await ffmpegAvailable();

const library = {
  armed: false,
  file: "",
  reached: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

const stallNextLookupOf = (file: string) =>
  Effect.sync(() => {
    library.armed = true;
    library.file = file;
    library.reached = Promise.withResolvers<void>();
    library.release = Promise.withResolvers<void>();
  });

const releaseLookups = Effect.sync(() => {
  library.armed = false;
  library.release.resolve();
});

const hungShare = (real: FileSystem.FileSystem) =>
  FileSystem.FileSystem.of({
    ...real,
    realPath: (path) =>
      library.armed && path.endsWith(library.file)
        ? Effect.suspend(() => {
            library.armed = false;
            library.reached.resolve();

            return Effect.promise(() => library.release.promise);
          }).pipe(Effect.andThen(real.realPath(path)))
        : real.realPath(path),
  });

describe.skipIf(!hasFfmpeg)("direct files", () => {
  layer(MediaTestServer.layer({}, { fileSystem: hungShare }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "a direct play request answers within its bound while the library's share does not answer",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const workspace = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", workspace.library.directMovie);
          const token = signTestToken({ fid: fileId, sid: crypto.randomUUID() });
          const url = `${server.baseUrl}/media/direct/${fileId}?token=${encodeURIComponent(token)}`;

          yield* stallNextLookupOf(workspace.library.directMovie);

          const requested = yield* Effect.forkChild(HttpClient.get(url));
          yield* Effect.promise(() => library.reached.promise);

          const answered = yield* Fiber.join(requested).pipe(Effect.timeout("35 seconds"));

          assert.strictEqual(
            answered.status,
            503,
            "the request answers that the file is unreadable",
          );

          yield* releaseLookups;

          const after = yield* HttpClient.get(url);

          assert.strictEqual(after.status, 200, "the file plays once the share answers");
          yield* after.arrayBuffer;
        }).pipe(Effect.ensuring(releaseLookups)),
      90_000,
    );
  });
});
