import { tmpdir } from "node:os";

import { assert, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

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
