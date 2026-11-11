import { Effect, Layer } from "effect";
import type { HttpRouter } from "effect/http";

import type * as CoreCallers from "../core/core-callers.ts";
import { commandRoute } from "../http/command-routes.ts";
import * as CoreImports from "./core-imports.ts";

/** Adds the importer's routes, each run as the signed-in admin's core user. */
export const layer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | CoreCallers.Service | CoreImports.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const imports = yield* CoreImports.Service;

    yield* commandRoute("imports.connect", (args, caller) => imports.connect(args, caller.userId));
    yield* commandRoute("imports.preview", (args, caller) => imports.dryRun(args, caller.userId));
    yield* commandRoute("imports.start", (args, caller) =>
      imports.startImport(args, caller.userId),
    );
  }),
);
