import type { CallError } from "@media/sdk/effect";
import { Effect, Layer, Stream } from "effect";

import * as MediaBackend from "../convex/media-backend.ts";

/** Answers to `call`, by function name. */
export type Handlers = {
  readonly [Name in MediaBackend.FunctionName]?: (
    args: MediaBackend.FunctionArgs<Name>,
  ) => Effect.Effect<MediaBackend.FunctionResult<Name>, CallError>;
};

/** Results of `subscribe`, by query name. */
export type Feeds = {
  readonly [Name in MediaBackend.QueryName]?: (
    args: MediaBackend.FunctionArgs<Name>,
  ) => Stream.Stream<MediaBackend.FunctionResult<Name>>;
};

/** A connected backend that answers with `handlers` and `feeds`. */
export const layer = (handlers: Handlers, feeds: Feeds): Layer.Layer<MediaBackend.Service> =>
  Layer.succeed(
    MediaBackend.Service,
    MediaBackend.Service.of({
      call: (name, args) => {
        const handler = handlers[name];

        return handler === undefined ? Effect.die(`No test answer for ${name}`) : handler(args);
      },
      subscribe: (name, args) => {
        const feed = feeds[name];

        return feed === undefined ? Stream.never : feed(args);
      },
      status: Effect.succeed("connected"),
    }),
  );
