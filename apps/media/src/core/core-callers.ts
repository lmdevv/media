/**
 * Who calls the server's own HTTP routes (ADR 0010): the person whose core session's Convex auth
 * token arrives as a bearer token. The server asks the core with that token, through
 * `core.auth.sessions.current`, and maps the routes' access levels onto the core's scopes and
 * roles.
 */
import { Forbidden } from "@media/contracts/errors";
import { UserId } from "@media/contracts/ids";
import type { CommandAccess } from "@media/contracts/scopes";
import { ConvexTransport, ProtocolError } from "@media/sdk/effect";
import type { CallError } from "@media/sdk/effect";
import { Context, Effect, Layer, Redacted, Schema } from "effect";

/** The core's answer to `core.auth.sessions.current`, as far as the server reads it. */
const CurrentSession = Schema.Struct({
  userId: Schema.String,
  role: Schema.Literals(["owner", "admin", "member", "guest"]),
  scopes: Schema.Array(Schema.String),
});

const decodeCurrent = Schema.decodeUnknownEffect(CurrentSession);

const CURRENT = "core/auth/sessions:current";

/** A signed-in person calling one of the server's routes. */
export interface Caller {
  /** The core user. */
  readonly userId: UserId;
  readonly role: typeof CurrentSession.Type.role;
  /** What the session may do, as the core cuts it to the role on each call. */
  readonly scopes: ReadonlyArray<string>;
}

/** Whether `caller` is an owner or an admin whose session holds the core's `admin` scope. */
export const isAdmin = (caller: Caller): boolean =>
  (caller.role === "owner" || caller.role === "admin") && caller.scopes.includes("admin");

/** The core scope each access level a person may hold needs. */
const SCOPE_OF = {
  read: "movies:read",
  play: "movies:play",
  manage: "movies:edit",
  account: "account",
} as const;

/**
 * Whether `caller` holds `access`, the access level a media command names: any session for
 * `public` and `authenticated`, a movies scope for `read`, `play`, and `manage` (`movies:edit`),
 * the core's `account` scope for `account`, an owner's or admin's `admin` scope for `admin`, and
 * never `media-service`, which no person holds.
 */
export const holds = (caller: Caller, access: CommandAccess): boolean =>
  access === "public" || access === "authenticated"
    ? true
    : access === "admin"
      ? isAdmin(caller)
      : access === "media-service"
        ? false
        : caller.scopes.includes(SCOPE_OF[access]);

const refusal = (access: CommandAccess): string =>
  access === "admin"
    ? "Only an owner or an admin may do this"
    : access === "media-service"
      ? "Only the media service may do this"
      : access === "public" || access === "authenticated"
        ? "Sign in first"
        : `This session lacks the ${SCOPE_OF[access]} scope`;

/** Checks who a bearer token belongs to and what it may do. */
export interface Interface {
  /**
   * The caller behind `bearer` when its session holds `access`. Fails with `Unauthenticated` for
   * a token the core does not accept and `Forbidden` when the session may not.
   */
  readonly authorize: (
    bearer: Redacted.Redacted,
    access: CommandAccess,
  ) => Effect.Effect<Caller, CallError>;
}

/** The caller check. */
export class Service extends Context.Service<Service, Interface>()("@media/server/CoreCallers") {}

/** Checks callers against the core at `coreUrl`, over a connection per call that carries their token. */
export const layer = (coreUrl: string): Layer.Layer<Service> =>
  Layer.succeed(
    Service,
    Service.of({
      authorize: Effect.fn("CoreCallers.authorize")(function* (bearer, access) {
        const current = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(ConvexTransport.layerHttp(coreUrl));
            const transport = Context.get(context, ConvexTransport.ConvexTransport);

            yield* transport.setAuth(() => Promise.resolve(Redacted.value(bearer)));

            const raw = yield* transport.call("query", CURRENT, {});

            return yield* decodeCurrent(raw).pipe(
              Effect.mapError(
                (cause) =>
                  new ProtocolError({
                    operation: "core.auth.sessions.current",
                    message: "Protocol error in core.auth.sessions.current: unexpected session",
                    cause,
                  }),
              ),
            );
          }),
        );

        const caller: Caller = {
          userId: UserId.make(current.userId),
          role: current.role,
          scopes: current.scopes,
        };

        if (!holds(caller, access)) return yield* new Forbidden({ message: refusal(access) });

        return caller;
      }),
    }),
  );
