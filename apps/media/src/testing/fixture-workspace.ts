import { Context, Effect, FileSystem, Layer, Path, type PlatformError } from "effect";

import { copyTree } from "./byte-copies.ts";
import { type FixtureLibrary, generateFixtureLibrary } from "./fixture-library.ts";

interface LibraryCopy {
  readonly root: string;
  readonly movies: string;
  readonly shows: string;
}

/** The fixture workspace. */
export interface Interface {
  /** Folder that holds the pristine library and every copy; approve it as a library root. */
  readonly root: string;
  readonly library: FixtureLibrary;
  /** Makes a new private copy each time it runs. */
  readonly copy: Effect.Effect<LibraryCopy, PlatformError.PlatformError>;
}

/** The fixture workspace. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/test/FixtureWorkspace",
) {}

/** Generates the fixture library into a fresh temporary folder. */
export const layer: Layer.Layer<Service, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const root = yield* fs
      .makeTempDirectoryScoped({ prefix: "movies-media-test-" })
      .pipe(Effect.orDie);

    const pristine = path.join(root, "pristine");
    const library = yield* Effect.promise(() => generateFixtureLibrary(pristine));
    let copies = 0;

    const copy = Effect.gen(function* () {
      copies += 1;
      const target = path.join(root, `copy-${copies}`);
      yield* copyTree(pristine, target).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

      return {
        root: target,
        movies: path.join(target, "movies"),
        shows: path.join(target, "shows"),
      };
    });

    return Service.of({ root, library, copy });
  }),
);
