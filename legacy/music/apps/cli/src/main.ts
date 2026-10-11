import { Effect } from "effect";

import { runCli } from "./cli";
import { Output, processOutput } from "./output";

process.exitCode = await Effect.runPromise(
  runCli(process.argv.slice(2)).pipe(Effect.provideService(Output, processOutput)),
);
