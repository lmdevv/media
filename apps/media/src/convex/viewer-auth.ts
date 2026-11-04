import { commands } from "@media/contracts/commands";
import { Forbidden } from "@media/contracts/errors";
import type { Viewer } from "@media/contracts/models/account";
import type { CommandAccess } from "@media/contracts/scopes";
import { ConvexTransport, ProtocolError } from "@media/sdk/effect";
import type { CallError } from "@media/sdk/effect";
import { Context, Effect, Layer, Redacted, Schema } from "effect";

/** Checks who a bearer token belongs to and what it may do. */
export interface Interface {
  /**
   * The viewer behind `bearer` when its session holds `access`. Fails with `Unauthenticated`
   * for a token Convex does not accept and `Forbidden` when the session lacks the scope.
   */
  readonly authorize: (
    bearer: Redacted.Redacted,
    access: CommandAccess,
  ) => Effect.Effect<Viewer, CallError>;
}

/** The viewer authorizer. */
export class Service extends Context.Service<Service, Interface>()("@media/server/ViewerAuth") {}

const viewerCommand = commands["account.viewer"];

const decodeViewer = Schema.decodeUnknownEffect(viewerCommand.result);

/** Authorizes against the Convex deployment at `convexUrl`. */
export const layer = (convexUrl: string): Layer.Layer<Service> =>
  Layer.succeed(
    Service,
    Service.of({
      authorize: Effect.fn("ViewerAuth.authorize")(function* (bearer, access) {
        const viewer = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(ConvexTransport.layerHttp(convexUrl));
            const transport = Context.get(context, ConvexTransport.ConvexTransport);

            yield* transport.setAuth(() => Promise.resolve(Redacted.value(bearer)));

            const raw = yield* transport.call("query", viewerCommand.function, {});

            return yield* decodeViewer(raw).pipe(
              Effect.mapError(
                (cause) =>
                  new ProtocolError({
                    operation: "account.viewer",
                    message: "Protocol error in account.viewer: unexpected viewer",
                    cause,
                  }),
              ),
            );
          }),
        );

        const allowed =
          access === "public" ||
          access === "authenticated" ||
          viewer.scopes.some((scope) => scope === access);

        if (!allowed) {
          return yield* new Forbidden({ message: `This session lacks the ${access} scope` });
        }

        return viewer;
      }),
    }),
  );
