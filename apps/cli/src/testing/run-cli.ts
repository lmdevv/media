import { ConfigProvider, Effect, Schema } from "effect";

import { runCli } from "../cli";
import { Output } from "../output";

/** The outcome of one invocation. */
export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `media <argv>` with only `env` as its environment. */
export const runInProcess = async (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Promise<CliRun> => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];

  const output = Output.of({
    out: (text) =>
      Effect.sync(() => {
        stdout.push(text);
      }),
    err: (text) =>
      Effect.sync(() => {
        stderr.push(text);
      }),
  });

  const code = await Effect.runPromise(
    runCli(argv).pipe(
      Effect.provideService(Output, output),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { ...env } }),
      ),
    ),
  );

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
};

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** The JSON value of each line of an invocation's stderr, failing on a line that is not JSON. */
export const stderrRecords = (stderr: string): ReadonlyArray<Schema.Json> =>
  stderr
    .trimEnd()
    .split("\n")
    .map((line) => decodeJsonLine(line));
