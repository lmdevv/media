import { Effect } from "effect";

import { runCli } from "./cli";
import { Input, processInput } from "./input";
import { Output, processOutput } from "./output";

process.exitCode = await Effect.runPromise(
  runCli(process.argv.slice(2)).pipe(
    Effect.provideService(Output, processOutput),
    Effect.provideService(Input, processInput),
  ),
);
