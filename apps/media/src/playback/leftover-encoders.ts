import { Effect, FileSystem, Option, Path } from "effect";

const DIGITS = /^\d+$/u;

/** A script runs behind its interpreter, which leaves the script's path second. */
const runsCommand = (argv: ReadonlyArray<string>, command: string) =>
  argv.slice(0, 2).includes(command);

const writesInto = (argv: ReadonlyArray<string>, folder: string) =>
  argv.some((arg) => arg.startsWith(folder));

const leadsItsGroup = (pid: number, group: Option.Option<number>) =>
  Option.exists(group, (leader) => leader === pid);

/** The process group in a `/proc/<pid>/stat` line, whose command name may hold any character. */
const groupOf = (stat: string): Option.Option<number> => {
  const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);

  return Number.isInteger(group) ? Option.some(group) : Option.none();
};

/**
 * Kills the process groups of encoders a previous run of the server left running, as a crash
 * does: ffmpeg runs in its own process group, which outlives the server. Finds none where there
 * is no `/proc`.
 */
export const kill = Effect.fn("LeftoverEncoders.kill")(function* (owner: {
  readonly ffmpegPath: string;
  readonly transcodeDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const transcodeFolder = path.join(owner.transcodeDir, "/");
  const names = yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []));

  for (const name of names) {
    const pid = Number(name);

    if (!DIGITS.test(name) || pid === process.pid) continue;

    const argv = yield* fs.readFile(`/proc/${name}/cmdline`).pipe(
      Effect.map((bytes) => new TextDecoder().decode(bytes).split("\0")),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

    if (!runsCommand(argv, owner.ffmpegPath) || !writesInto(argv, transcodeFolder)) continue;

    const group = yield* fs
      .readFileString(`/proc/${name}/stat`)
      .pipe(Effect.map(groupOf), Effect.orElseSucceed(Option.none<number>));

    if (!leadsItsGroup(pid, group)) continue;

    yield* Effect.try(() => process.kill(-pid, "SIGKILL")).pipe(Effect.ignore);
    yield* Effect.logWarning("StreamSessions.leftover_encoder_killed").pipe(
      Effect.annotateLogs({ pid }),
    );
  }
});
