import type { FunctionArgs } from "convex/server";
import { Schema } from "effect";

import type { GrantPrincipal, Level } from "../commands/access";
import type { CallerScope } from "../commands/scopes";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { runFunction } from "./admin";
import type { SignedIn } from "./sign-in";
import type { CoreStack } from "./stack-env";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one as an `accessProbes` id; the backend's `v.id("accessProbes")`
// validators check it again whenever a test sends it back.
const isProbeId = (value: unknown): value is Id<"accessProbes"> => Schema.is(Schema.String)(value);

const ProbeId = Schema.declare(isProbeId);

const Opened = Schema.Struct({
  probeId: ProbeId,
  name: Schema.String,
  level: Schema.Literals(["view", "edit", "manage"]),
});

const Page = Schema.Struct({
  page: Schema.Array(Opened),
  isDone: Schema.Boolean,
  continueCursor: Schema.String,
});

/** A signed-in client with the ids the probe seam takes. */
export interface Session {
  readonly signedIn: SignedIn;
  readonly userId: Id<"users">;
  readonly sessionId: Id<"authSessions">;
}

/** A probe to seed: a movie with a minimum viewer age or none, or a song, explicit or not. */
export type Probe = FunctionArgs<typeof internal.core.permissions.probe.seed>["probes"][number];

/** A movie probe; `age` null is unrated. */
export const movie = (name: string, age: number | null): Probe => ({
  name,
  domain: "movies",
  age,
  explicit: false,
});

/** A music probe. */
export const song = (name: string, explicit: boolean): Probe => ({
  name,
  domain: "music",
  age: null,
  explicit,
});

/** The session behind a signed-in client, read through `core.auth.sessions.current`. */
export const sessionOf = async (signedIn: SignedIn): Promise<Session> => {
  const current = await signedIn.client.query(api.core.auth.sessions.current, {});

  return { signedIn, userId: current.userId, sessionId: current.sessionId };
};

/** Seeds probes that `manager` manages, in order. */
export const seedProbes = (
  stack: CoreStack,
  manager: Session,
  probes: ReadonlyArray<Probe>,
): Promise<ReadonlyArray<Id<"accessProbes">>> =>
  runFunction(
    stack,
    internal.core.permissions.probe.seed,
    { managerId: manager.userId, probes: [...probes] },
    Schema.Array(ProbeId),
  );

/** Opens a probe as `session` would through a command that declares `scope`. */
export const openProbe = (
  stack: CoreStack,
  session: Session,
  probeId: Id<"accessProbes">,
  action: FunctionArgs<typeof internal.core.permissions.probe.open>["action"] = "view",
  scope: CallerScope = "signed-in",
): Promise<typeof Opened.Type> =>
  runFunction(
    stack,
    internal.core.permissions.probe.open,
    { sessionId: session.sessionId, scope, action, probeId },
    Opened,
  );

/**
 * One page of the probes `session` sees. Calls with another `id` miss the query cache, so each
 * one runs and reads.
 */
export const probePage = (
  stack: CoreStack,
  session: Session,
  numItems: number,
  cursor: string | null = null,
  id?: number,
): Promise<typeof Page.Type> =>
  runFunction(
    stack,
    internal.core.permissions.probe.list,
    {
      sessionId: session.sessionId,
      scope: "signed-in",
      paginationOpts: id === undefined ? { numItems, cursor } : { numItems, cursor, id },
    },
    Page,
  );

/** Every probe `session` sees, page by page. */
export const visibleProbes = async (
  stack: CoreStack,
  session: Session,
  cursor: string | null = null,
  seen: ReadonlyArray<Id<"accessProbes">> = [],
): Promise<ReadonlyArray<Id<"accessProbes">>> => {
  const page = await probePage(stack, session, 100, cursor);
  const next = [...seen, ...page.page.map((probe) => probe.probeId)];

  return page.isDone ? next : visibleProbes(stack, session, page.continueCursor, next);
};

/** Gives `principal` exactly `level` on a probe, as `session`. */
export const shareProbe = (
  stack: CoreStack,
  session: Session,
  probeId: Id<"accessProbes">,
  principal: GrantPrincipal,
  level: Level,
): Promise<null> =>
  runFunction(
    stack,
    internal.core.permissions.probe.share,
    { sessionId: session.sessionId, probeId, principal, level },
    Schema.Null,
  );

/** Takes `principal`'s grant on a probe away, as `session`. */
export const unshareProbe = (
  stack: CoreStack,
  session: Session,
  probeId: Id<"accessProbes">,
  principal: GrantPrincipal,
): Promise<null> =>
  runFunction(
    stack,
    internal.core.permissions.probe.unshare,
    { sessionId: session.sessionId, probeId, principal },
    Schema.Null,
  );
