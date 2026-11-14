/** The real file system with one step held until a test releases it. */
import { Deferred, Effect, FileSystem, Ref } from "effect";

/** When a held step starts, and what lets it go on. */
interface Hold {
  /** Completes when the held step starts. */
  readonly reached: Deferred.Deferred<void>;
  /** The held step goes on once this completes. */
  readonly release: Deferred.Deferred<void>;
}

const held = <A, E>({ reached, release }: Hold, step: Effect.Effect<A, E>) =>
  Deferred.succeed(reached, undefined).pipe(
    Effect.andThen(Deferred.await(release)),
    Effect.andThen(step),
  );

/**
 * The file system with the first listing of `root` held, counting every listing of `root` in
 * `listings`.
 */
export const listingHeldUntil = (root: string, hold: Hold, listings: Ref.Ref<number>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return FileSystem.FileSystem.of({
      ...fs,
      readDirectory: (path, options) =>
        path === root
          ? Ref.getAndUpdate(listings, (count) => count + 1).pipe(
              Effect.flatMap((before) =>
                before === 0
                  ? held(hold, fs.readDirectory(path, options))
                  : fs.readDirectory(path, options),
              ),
            )
          : fs.readDirectory(path, options),
    });
  });

/** The file system with every removal of `target` held. */
export const removalHeldUntil = (target: string, hold: Hold) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return FileSystem.FileSystem.of({
      ...fs,
      remove: (path, options) =>
        path === target ? held(hold, fs.remove(path, options)) : fs.remove(path, options),
    });
  });
