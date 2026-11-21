import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";

import { InsufficientTranscodeSpace } from "@media/contracts/media-playback";

import { freeBytes } from "../platform/node-directories.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as TranscodeSpace from "./transcode-space.ts";

const transcodeDir = tmpdir();

const spaceLayer = TranscodeSpace.layer.pipe(
  Layer.provide(testConfigLayer({ TRANSCODE_DIR: transcodeDir, MIN_FREE_TRANSCODE_MB: "1" })),
);

layer(spaceLayer)("TranscodeSpace", (it) => {
  it.effect("counts what is reserved as used until it is released", () =>
    Effect.gen(function* () {
      const space = yield* TranscodeSpace.Service;
      const most = Math.floor((yield* Effect.promise(() => freeBytes(transcodeDir))) * 0.6);

      yield* space.check(most);
      yield* space.reserve("download:a", most);

      const refused = yield* space.check(most).pipe(Effect.flip);

      assert.instanceOf(refused, InsufficientTranscodeSpace);
      assert.isAbove(refused.requiredBytes, 2 * most);

      yield* space.check(0);
      yield* space.release("download:a");
      yield* space.check(most);
    }),
  );
});

const warnings: Array<{ readonly message: unknown; readonly code: unknown }> = [];

const unreadableLayer = Layer.mergeAll(
  TranscodeSpace.layer.pipe(
    Layer.provide(
      testConfigLayer({ TRANSCODE_DIR: join(transcodeDir, "media-transcode-space-missing") }),
    ),
  ),
  Logger.layer([
    Logger.make((options) => {
      warnings.push({
        message: options.message,
        code: options.fiber.getRef(References.CurrentLogAnnotations)["code"],
      });
    }),
  ]),
);

layer(unreadableLayer)("TranscodeSpace over a folder it cannot read", (it) => {
  it.effect("lets a session start, and logs why it could not check", () =>
    Effect.gen(function* () {
      const space = yield* TranscodeSpace.Service;

      yield* space.check(Number.MAX_SAFE_INTEGER);

      assert.deepStrictEqual(warnings, [
        { message: ["TranscodeSpace.free_space_unknown"], code: "ENOENT" },
      ]);
    }),
  );
});
