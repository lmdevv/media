import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import * as MediaConfig from "../media-config.ts";

/** What tells a process apart from a later one that reuses its id. */
const Identity = Schema.Struct({
  group: Schema.Int,
  startTime: Schema.String,
  executable: Schema.String,
});

type Identity = typeof Identity.Type;

const IdentityJson = Schema.fromJsonString(Identity);

const decodeIdentity = Schema.decodeUnknownEffect(IdentityJson);

const encodeIdentity = Schema.encodeEffect(IdentityJson);

const sameProcess = (left: Identity, right: Identity): boolean =>
  left.group === right.group &&
  left.startTime === right.startTime &&
  left.executable === right.executable;

/** The encoders this server started, kept on disk so the next start can stop what a crash left. */
export interface Interface {
  /** Records the process group `pid` leads. Does nothing where there is no `/proc`. */
  readonly record: (pid: number) => Effect.Effect<void>;
  /** Forgets `pid`, once its exit is confirmed. */
  readonly forget: (pid: number) => Effect.Effect<void>;
}

/** The encoder records. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/EncoderRecords",
) {}

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(config.dataDir, "encoders");
  const fileOf = (pid: number) => path.join(folder, `${String(pid)}.json`);

  const identify = (pid: number) =>
    Effect.all({
      stat: fs.readFileString(`/proc/${String(pid)}/stat`),
      executable: fs.readLink(`/proc/${String(pid)}/exe`),
    }).pipe(
      Effect.map(({ stat, executable }): Identity => {
        // The command name in parentheses may hold any character; the fields after it are fixed.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");

        return { group: Number(fields[2]), startTime: fields[19] ?? "", executable };
      }),
      Effect.option,
    );

  for (const name of yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []))) {
    const file = path.join(folder, name);

    const recorded = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(decodeIdentity), Effect.option);

    if (Option.isSome(recorded)) {
      const now = yield* identify(recorded.value.group);

      if (Option.exists(now, (current) => sameProcess(current, recorded.value))) {
        yield* Effect.try(() => process.kill(-recorded.value.group, "SIGKILL")).pipe(Effect.ignore);
        yield* Effect.logWarning("EncoderRecords.leftover_killed").pipe(
          Effect.annotateLogs({ pid: recorded.value.group }),
        );
      }
    }

    yield* fs.remove(file, { force: true }).pipe(Effect.ignore);
  }

  yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.ignore);

  const record = (pid: number) =>
    identify(pid).pipe(
      Effect.flatMap((identity) =>
        Option.isSome(identity) && identity.value.group === pid
          ? encodeIdentity(identity.value).pipe(
              Effect.flatMap((json) => fs.writeFileString(`${fileOf(pid)}.tmp`, json)),
              Effect.andThen(fs.rename(`${fileOf(pid)}.tmp`, fileOf(pid))),
            )
          : Effect.void,
      ),
      Effect.ignore,
    );

  const forget = (pid: number) => fs.remove(fileOf(pid), { force: true }).pipe(Effect.ignore);

  return Service.of({ record, forget });
});

/**
 * Encoder records under `DATA_DIR`. Building it kills each process group an earlier run recorded
 * whose leader still has the recorded start time and executable, then clears the records.
 */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path
> = Layer.effect(Service, make);
