import { Forbidden } from "@media/contracts/errors";
import { Layer, Effect } from "effect";
import type { FileSystem, Path } from "effect";
import type { HttpRouter } from "effect/http";

import * as CoreCallers from "../core/core-callers.ts";
import { commandRoute } from "../http/command-routes.ts";
import type * as MediaConfig from "../media-config.ts";
import * as ServerFolders from "./server-folders.ts";

/** Adds the folder browser route, for owners and admins. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | CoreCallers.Service
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      MediaConfig.Service | FileSystem.FileSystem | Path.Path
    >();

    // Only who may point a library at folders (`manageFolders` on the core: owners and admins)
    // browses the server's folders, as only admins could on old movies.
    yield* commandRoute("libraries.folders", ({ path }, caller) =>
      CoreCallers.isAdmin(caller)
        ? ServerFolders.list(path).pipe(Effect.provideContext(context))
        : Effect.fail(
            new Forbidden({ message: "Only an owner or an admin may browse the server's folders" }),
          ),
    );
  }),
);
