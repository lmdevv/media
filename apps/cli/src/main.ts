/**
 * The `media` executable. No top-level await: the standalone binary embeds this as CommonJS
 * (scripts/build-sea.ts).
 */
import { Effect } from "effect";

import { runCli } from "./cli";
import { ExitCode } from "./cli-errors";
import { Output, processOutput } from "./output";

// A reader that stops early, as `media logs | head` or `| grep -q` does, closes stdout: the
// output has ended, not the command, so it exits as a finished command, never with a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  process.exit(error.code === "EPIPE" ? ExitCode.ok : ExitCode.failed);
});

Effect.runFork(
  runCli(process.argv.slice(2)).pipe(
    Effect.provideService(Output, processOutput),
    Effect.flatMap((code) =>
      Effect.sync(() => {
        process.exitCode = code;
      }),
    ),
  ),
);
