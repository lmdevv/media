import { InsufficientTranscodeSpace } from "@media/contracts/media-playback";
import { Context, Effect, Layer, Ref } from "effect";

import * as MediaConfig from "../media-config.ts";
import { errorCode, freeBytes } from "../platform/node-directories.ts";

/** Checks and reserves space in `TRANSCODE_DIR`. */
export interface Interface {
  /**
   * Fails with `InsufficientTranscodeSpace` unless the disk holds the configured minimum plus
   * every reservation plus `bytes`. An unknown free space (the directory cannot be read) passes, as
   * the write will fail anyway.
   */
  readonly check: (bytes: number) => Effect.Effect<void, InsufficientTranscodeSpace>;
  /** Counts `bytes` as used under `key` until it is released. */
  readonly reserve: (key: string, bytes: number) => Effect.Effect<void>;
  /** Drops the reservation under `key`, once its bytes are on disk or never will be. */
  readonly release: (key: string) => Effect.Effect<void>;
}

/** The transcode space ledger. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/TranscodeSpace",
) {}

/** The ledger over the configured `TRANSCODE_DIR`. */
export const layer: Layer.Layer<Service, never, MediaConfig.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const reserved = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    const check = Effect.fn("TranscodeSpace.check")(function* (bytes: number) {
      const available = yield* Effect.tryPromise(() => freeBytes(config.transcodeDir)).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("TranscodeSpace.free_space_unknown").pipe(
            Effect.annotateLogs({ code: errorCode(error.cause) }),
          ),
        ),
        Effect.orElseSucceed(() => Number.POSITIVE_INFINITY),
      );

      const pending = [...(yield* Ref.get(reserved)).values()].reduce(
        (total, held) => total + held,
        0,
      );

      const required = config.minFreeTranscodeBytes + pending + bytes;

      return yield* available < required
        ? new InsufficientTranscodeSpace({ freeBytes: available, requiredBytes: required })
        : Effect.void;
    });

    const reserve = (key: string, bytes: number) =>
      Ref.update(reserved, (current) => new Map(current).set(key, bytes));

    const release = (key: string) =>
      Ref.update(reserved, (current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);

        return next;
      });

    return Service.of({ check, reserve, release });
  }),
);
