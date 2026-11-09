import { Effect, FileSystem, Option, Path } from "effect";

/** A process as `/proc` describes it. */
interface ProcessInfo {
  readonly pid: number;
  readonly group: number;
  readonly argv: ReadonlyArray<string>;
}

/** Where this server's encoders run from and write to. */
export interface Ownership {
  readonly ffmpegPath: string;
  readonly transcodeDir: string;
}

const DIGITS = /^\d+$/u;

/**
 * Whether `info` is an encoder this server left running: the leader of its own process group, as
 * the server starts every ffmpeg, running the configured ffmpeg, directly or through a script's
 * interpreter, and writing into the server's transcode folder.
 */
const isLeftoverEncoder = (info: ProcessInfo, ffmpegPath: string, transcodeFolder: string) =>
  info.group === info.pid &&
  info.argv.slice(0, 2).includes(ffmpegPath) &&
  info.argv.some((arg) => arg.startsWith(transcodeFolder));

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
export const kill = Effect.fn("LeftoverEncoders.kill")(function* (owner: Ownership) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const transcodeFolder = path.join(owner.transcodeDir, "/");
  const names = yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []));

  for (const name of names) {
    const pid = Number(name);

    if (!DIGITS.test(name) || pid === process.pid) continue;

    const info = yield* Effect.all({
      group: fs.readFileString(`/proc/${name}/stat`).pipe(Effect.map(groupOf)),
      argv: fs
        .readFile(`/proc/${name}/cmdline`)
        .pipe(Effect.map((bytes) => new TextDecoder().decode(bytes).split("\0"))),
    }).pipe(Effect.option);

    if (Option.isNone(info) || Option.isNone(info.value.group)) continue;

    const leftover = isLeftoverEncoder(
      { pid, group: info.value.group.value, argv: info.value.argv },
      owner.ffmpegPath,
      transcodeFolder,
    );

    if (!leftover) continue;

    yield* Effect.try(() => process.kill(-pid, "SIGKILL")).pipe(Effect.ignore);
    yield* Effect.logWarning("StreamSessions.leftover_encoder_killed").pipe(
      Effect.annotateLogs({ pid }),
    );
  }
});
