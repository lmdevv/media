import { Conflict, Internal, NotFound } from "@media/contracts/errors";
import { Effect, Layer } from "effect";
import type { HttpRouter } from "effect/http";

import type * as CoreCallers from "../core/core-callers.ts";
import { commandRoute } from "../http/command-routes.ts";
import * as Backups from "./backups.ts";

/** Adds the restore route. */
export const layer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | CoreCallers.Service | Backups.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backups = yield* Backups.Service;

    yield* commandRoute(
      "backups.restore",
      Effect.fn("BackupRoutes.restore")(function* ({ backupId }) {
        yield* backups.restore(backupId).pipe(
          Effect.catchTags({
            BackupBusy: (error) => Effect.fail(new Conflict({ message: error.message })),
            BackupArchiveMissing: (error) => Effect.fail(new NotFound({ message: error.message })),
            BackupFolderFailed: (error) => Effect.fail(new Internal({ message: error.message })),
            ConvexCliFailed: (error) =>
              Effect.fail(new Internal({ message: `Restore failed: ${error.message}` })),
            ConvexCliUnavailable: (error) => Effect.fail(new Internal({ message: error.message })),
          }),
        );

        return { ok: true as const };
      }),
    );
  }),
);
