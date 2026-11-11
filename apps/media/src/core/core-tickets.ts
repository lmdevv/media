import { createHash } from "node:crypto";

import { MediaFileId, PlaybackSessionId, UserId } from "@media/contracts/ids";
import { PlaybackSessionEnded } from "@media/contracts/media-playback";
import { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { serverFunctions } from "@media/contracts/server-functions";
import type { SessionStatus } from "@media/contracts/server-functions";
import {
  artworkTicketId,
  loadTicketKeyRing,
  TICKET_PARAM,
  ticketResourceKinds,
} from "@media/contracts/ticket";
import type {
  SessionPrincipal,
  SessionState,
  TicketAdmission,
  TicketClaims,
  TicketKeyRing,
  TicketPurpose,
  TicketRefused,
  TicketResource,
} from "@media/contracts/ticket";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  RcMap,
  Redacted,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";

import * as ArtworkGate from "../artwork/artwork-gate.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import type { PlaybackGrant, TokenPurpose } from "../playback/playback-token.ts";
import * as SessionReports from "../playback/session-reports.ts";
import { SessionReport } from "../playback/stream-liveness.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import * as CoreSession from "./core-session.ts";

/** `MEDIA_TICKET_KEYS` cannot be used. Names the problem, never the keys. */
export class TicketKeysUnusable extends Schema.TaggedError<TicketKeysUnusable>()(
  "TicketKeysUnusable",
  { problem: Schema.String },
) {
  override get message(): string {
    return `MEDIA_TICKET_KEYS is not usable: ${this.problem}`;
  }
}

/** What the core tickets adapter needs. */
export interface Options {
  /** The same `MEDIA_TICKET_KEYS` ring the core signs with (ADR 0011). */
  readonly ticketKeys: Redacted.Redacted;
  /** `STREAM_IDLE_SECONDS`: how long a direct-play ticket keeps continuing after its last use. */
  readonly idle: Duration.Duration;
}

/** How long the first answer of a session's watch may take before a ticket is refused. */
const FIRST_STATUS_WAIT = Duration.seconds(5);

/** How long a session's watch outlives its last user, so a run of requests shares one. */
const WATCH_IDLE = Duration.minutes(1);

const SWEEP_EVERY = Duration.minutes(1);

/** A started play ticket and the session it runs under, kept by the playback it identifies. */
interface Entry {
  readonly admission: TicketAdmission;
  readonly claims: Extract<TicketClaims, { readonly kind: "personal" }>;
  readonly guest: boolean;
  readonly endsAt: number;
  readonly lastUsedAt: number;
  /** A digest of the admitted ticket, to match a report's ticket without keeping the ticket. */
  readonly digest: string;
}

const keyOf = (principal: SessionPrincipal): string => `${principal.userId}.${principal.sessionId}`;

const principalOf = (key: string): SessionPrincipal => {
  const [userId = "", sessionId = ""] = key.split(".");

  return { userId, sessionId };
};

const digestOf = (ticket: string): string =>
  createHash("sha256").update(ticket).digest("hex").slice(0, 32);

/**
 * The playback a ticket starts, which names the stream sessions its streams join: the playback
 * the ticket signs (`movies.play.start`'s `playbackId`, one per start, so two starts in one second
 * are two playbacks), or for a ticket that names none a digest of it. Logs that name the session
 * never hold the ticket.
 */
const playbackOf = (claims: TicketClaims | undefined, ticket: string): PlaybackSessionId =>
  claims?.kind === "personal" && claims.playback !== undefined
    ? PlaybackSessionId.make(claims.playback)
    : PlaybackSessionId.make(`t${digestOf(ticket)}`);

/** The playback a ticket's text names, unchecked: a key to find its entry, then compare digests. */
const claimedPlaybackOf = (ticket: string): PlaybackSessionId => {
  const parts = ticket.split(".");

  return parts.length === 13 && parts[8] === "s"
    ? PlaybackSessionId.make(parts[11] ?? "")
    : PlaybackSessionId.make(`t${digestOf(ticket)}`);
};

const RESOURCE_ID = /^[\w-]{1,128}$/u;

// SAFETY: a type predicate, checked against the list of resource kinds it narrows to.
const isResourceKind = (kind: string): kind is TicketResource["kind"] =>
  ticketResourceKinds.some((known) => known === kind);

/**
 * The resource a ticket's text names, for the route that serves it: every byte route serves the
 * file its ticket names, then checks it against its path. An unreadable ticket gets a resource
 * that `admit` refuses after it refuses the ticket's shape.
 */
const resourceOf = (ticket: string): TicketResource => {
  const [, , , , , , kind = "", id = ""] = ticket.split(".");

  return isResourceKind(kind) && RESOURCE_ID.test(id) ? { kind, id } : { kind: "file", id: "-" };
};

const invalid = (reason: PlaybackTokenInvalid["reason"], message: string): PlaybackTokenInvalid =>
  new PlaybackTokenInvalid({ reason, message });

const UNREADABLE = "This ticket is not one this server can read";

const EXPIRED = "This ticket expired; start playback again";

/**
 * How each refusal reads on the byte routes, in the old tokens' terms the players already handle.
 * A missing reason fails to compile.
 */
const REFUSALS = {
  malformed: ["malformed", UNREADABLE],
  unknown_key: ["malformed", UNREADABLE],
  overlong: ["malformed", UNREADABLE],
  bad_signature: ["bad_signature", "This ticket's signature does not match"],
  wrong_audience: ["wrong_audience", "This ticket is for another server"],
  wrong_purpose: ["wrong_purpose", "This ticket is for another purpose"],
  wrong_resource: ["wrong_purpose", "This ticket is for another item"],
  not_yet_valid: ["expired", EXPIRED],
  expired: ["expired", EXPIRED],
  other_ticket: ["malformed", "This ticket did not start this stream"],
  session_unavailable: ["expired", "The server could not confirm this sign-in; try again"],
  session_ended: ["expired", "This sign-in ended"],
} as const satisfies {
  readonly [Reason in TicketRefused["reason"]]: readonly [PlaybackTokenInvalid["reason"], string];
};

const refusalOf = (
  refused: TicketRefused,
  playback: PlaybackSessionId,
): PlaybackTokenInvalid | PlaybackSessionEnded => {
  if (refused.reason === "session_ended") return new PlaybackSessionEnded({ sessionId: playback });

  const [reason, message] = REFUSALS[refused.reason];

  return invalid(reason, message);
};

const refuse = (refused: TicketRefused, playback: PlaybackSessionId) =>
  new PlaybackToken.TokenRefused({
    error: refusalOf(refused, playback),
    sessionForLog: sessionForLog(refused.claims, playback),
  });

const stateOf = (status: Option.Option<SessionStatus>, now: number): SessionState =>
  Option.match(status, {
    onNone: () => "unavailable",
    onSome: (known) => (known.state === "live" && known.endsAt > now ? "live" : "ended"),
  });

const sessionForLog = (claims: TicketClaims | undefined, playback: PlaybackSessionId) =>
  claims?.kind === "personal"
    ? Option.some({ sessionId: playback, userId: UserId.make(claims.principal.userId) })
    : Option.none();

/** The adapter's services, built once. */
interface Built {
  readonly tokens: PlaybackToken.Interface;
  readonly reports: SessionReports.Interface;
  readonly ring: TicketKeyRing;
  readonly readSession: (principal: SessionPrincipal) => Promise<SessionState>;
}

const make = Effect.fn("CoreTickets.make")(function* (options: Options) {
  const session = yield* CoreSession.Service;
  const owners = yield* StreamOwners.Service;

  const loaded = yield* Effect.promise(() => loadTicketKeyRing(Redacted.value(options.ticketKeys)));

  if (!loaded.ok) return yield* new TicketKeysUnusable({ problem: loaded.error.problem });

  const ring = loaded.value;
  const entries = new Map<PlaybackSessionId, Entry>();
  const idleMs = Duration.toMillis(options.idle);

  // One watch per signed-in session, shared by its tickets and streams, kept a minute past its
  // last user. `core/tickets:sessionStatus` reruns when the session or its user changes.
  const watches = yield* RcMap.make({
    lookup: (key: string) =>
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make(Option.none<SessionStatus>());

        yield* session.watch(serverFunctions.sessionStatus, principalOf(key)).pipe(
          Stream.runForEach((next) => SubscriptionRef.set(status, Option.some(next))),
          Effect.forkScoped,
        );

        return status;
      }),
    idleTimeToLive: WATCH_IDLE,
  });

  const statusOf = (principal: SessionPrincipal): Effect.Effect<Option.Option<SessionStatus>> =>
    Effect.scoped(
      RcMap.get(watches, keyOf(principal)).pipe(
        Effect.flatMap((status) =>
          SubscriptionRef.changes(status).pipe(
            Stream.filter(Option.isSome),
            Stream.map((known) => known.value),
            Stream.runHead,
            Effect.timeoutOption(FIRST_STATUS_WAIT),
            Effect.map(Option.flatten),
          ),
        ),
      ),
    );

  const runtime = yield* Effect.context();

  const readSession = (principal: SessionPrincipal): Promise<SessionState> =>
    Effect.runPromiseWith(runtime)(
      Effect.gen(function* () {
        const status = yield* statusOf(principal);

        return stateOf(status, yield* Clock.currentTimeMillis);
      }),
    );

  /**
   * One element once the session ends or reaches its own expiry on the server's clock, holding the
   * session's shared watch while it waits.
   */
  const endOf = (principal: SessionPrincipal): Stream.Stream<void> =>
    Stream.unwrap(
      RcMap.get(watches, keyOf(principal)).pipe(
        Effect.map((status) =>
          SubscriptionRef.changes(status).pipe(
            Stream.filter(Option.isSome),
            Stream.map((known) => known.value),
            Stream.switchMap((known) =>
              known.state === "ended"
                ? Stream.make(undefined)
                : Stream.fromEffect(
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((now) => Effect.sleep(Math.max(0, known.endsAt - now))),
                    ),
                  ),
            ),
            Stream.take(1),
          ),
        ),
      ),
    );

  const grantOf = (
    entry: Pick<Entry, "claims" | "guest" | "endsAt">,
    playback: PlaybackSessionId,
  ) => {
    const { claims } = entry;
    const purpose: TokenPurpose = claims.purpose === "download" ? "download" : "play";

    return {
      userId: UserId.make(claims.principal.userId),
      fileId: MediaFileId.make(claims.resource.id),
      sessionId: playback,
      purpose,
      audience: entry.guest ? "guest" : "household",
      // A stream keeps playing while its session holds, past its ticket (D46); a download is
      // admitted on each request, so its ticket's own expiry bounds it.
      expiresAt: purpose === "play" ? Math.max(entry.endsAt, claims.expiresAt) : claims.expiresAt,
      sessionEnded: Stream.runDrain(endOf(claims.principal)),
    } satisfies PlaybackGrant;
  };

  /** Continues the admission that started a playback: the same ticket, while its session holds. */
  const continued = Effect.fnUntraced(function* (
    entry: Entry,
    ticket: string,
    playback: PlaybackSessionId,
  ) {
    const result = yield* Effect.promise(() => entry.admission.continue(ticket));

    if (!result.ok) return yield* refuse(result.error, playback);

    const now = yield* Clock.currentTimeMillis;

    entries.set(playback, { ...entry, lastUsedAt: now });

    return grantOf(entry, playback);
  });

  const admitted = Effect.fnUntraced(function* (
    ticket: string,
    purposes: ReadonlyArray<TokenPurpose>,
    read: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;

    const route = {
      purposes: purposes satisfies ReadonlyArray<TicketPurpose>,
      resource: resourceOf(ticket),
    };

    const result = yield* Effect.promise(() => ring.admit({ ticket, route, readSession }, now));

    if (!result.ok) {
      const playback = playbackOf(result.error.claims, ticket);

      // A read starts no encoder: direct play, which has no stream id to continue by, and a
      // running stream's subtitles and thumbnails. Its expired play ticket keeps reading while
      // the playback has an open stream or was used within the idle time; a start never does.
      const previous = entries.get(playback);

      const reading =
        read &&
        result.error.reason === "expired" &&
        previous !== undefined &&
        (now - previous.lastUsedAt < idleMs || (yield* owners.hasOpen(playback)));

      return reading
        ? yield* continued(previous, ticket, playback)
        : yield* refuse(result.error, playback);
    }

    const { claims } = result.value;
    const playback = playbackOf(claims, ticket);

    // A shareable ticket is always for artwork, which no play or download route admits.
    if (claims.kind !== "personal") {
      return yield* new PlaybackToken.TokenRefused({
        error: invalid("wrong_purpose", "This ticket serves only artwork"),
        sessionForLog: Option.none(),
      });
    }

    const status = yield* statusOf(claims.principal);
    const live = Option.filter(status, (known) => known.state === "live");

    const entry: Entry = {
      admission: result.value,
      claims,
      guest: Option.exists(live, (known) => known.guest),
      endsAt: Option.match(live, {
        onNone: () => claims.expiresAt,
        onSome: (known) => known.endsAt,
      }),
      lastUsedAt: now,
      digest: digestOf(ticket),
    };

    if (claims.purpose === "play") entries.set(playback, entry);

    return grantOf(entry, playback);
  });

  const authorize: PlaybackToken.Interface["authorize"] = Effect.fn("CoreTickets.authorize")(
    function* (token, purposes, within) {
      const ticket = Redacted.value(token);

      if (within !== undefined && within !== PlaybackToken.READ) {
        const owner = yield* owners.ownerOf(within);
        const entry = Option.flatMap(owner, (id) => Option.fromUndefinedOr(entries.get(id)));

        // A running stream continues only on the admission that started it, found by the
        // stream's id, never by the ticket (ADR 0011).
        if (Option.isSome(entry) && Option.isSome(owner)) {
          return yield* continued(entry.value, ticket, owner.value);
        }
      }

      return yield* admitted(ticket, purposes, within === PlaybackToken.READ);
    },
  );

  const tokens = PlaybackToken.Service.of({
    param: TICKET_PARAM,
    withToken: (url, token) =>
      `${url}?${TICKET_PARAM}=${encodeURIComponent(Redacted.value(token))}`,
    authorize,
    verify: (token, purposes, within) =>
      authorize(token, purposes, within).pipe(Effect.mapError((refused) => refused.error)),
    verifyReport: (token) => {
      const ticket = Redacted.value(token);
      const playback = claimedPlaybackOf(ticket);
      const found = entries.get(playback);
      const entry = found?.digest === digestOf(ticket) ? found : undefined;

      return entry === undefined
        ? authorize(token, PlaybackToken.PLAY).pipe(
            Effect.mapError((refused) =>
              Predicate.isTagged(refused.error, "PlaybackTokenInvalid")
                ? refused.error
                : invalid("expired", "This playback ended"),
            ),
          )
        : Effect.succeed(grantOf(entry, playback));
    },
  });

  /**
   * A stream's session reports: `Ended` once the ticket's session ends or reaches its expiry.
   * The core reports no positions, so a live session says nothing and the stream keeps its
   * encoder on its requests alone.
   */
  const reports = SessionReports.Service.of({
    follow: (playback) => {
      const entry = entries.get(playback);

      if (entry === undefined) return Stream.never;

      return endOf(entry.claims.principal).pipe(Stream.map(() => SessionReport.Ended()));
    },
  });

  // Forgets playbacks whose ticket expired, that no open stream plays, and that went unused for
  // the idle time.
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    // Deleting the entry a Map iteration is on is safe; it goes on with the next one.
    for (const [playback, entry] of entries) {
      const forgettable = entry.claims.expiresAt <= now && now - entry.lastUsedAt >= idleMs;

      if (forgettable && !(yield* owners.hasOpen(playback))) entries.delete(playback);
    }
  }).pipe(Effect.repeat(Schedule.spaced(SWEEP_EVERY)), Effect.forkScoped);

  return { tokens, reports, ring, readSession } satisfies Built;
});

/**
 * The byte routes' grants from core tickets (`PlaybackToken.Service`), their streams' session
 * reports from the core's session watch, and the artwork gate for shareable tickets.
 */
export const layer = (
  options: Options,
): Layer.Layer<
  PlaybackToken.Service | SessionReports.Service | ArtworkGate.Service,
  TicketKeysUnusable,
  CoreSession.Service | StreamOwners.Service
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const built = yield* make(options);

      const gate = ArtworkGate.Service.of({
        param: TICKET_PARAM,
        admits: (ticket, key) =>
          Effect.all([Clock.currentTimeMillis, Effect.promise(() => artworkTicketId(key))]).pipe(
            Effect.flatMap(([now, artworkId]) =>
              Effect.promise(() =>
                built.ring.admit(
                  {
                    ticket,
                    route: { purposes: ["image"], resource: { kind: "artwork", id: artworkId } },
                    readSession: built.readSession,
                  },
                  now,
                ),
              ),
            ),
            Effect.map((result) => result.ok),
          ),
      });

      return Context.make(PlaybackToken.Service, built.tokens).pipe(
        Context.add(SessionReports.Service, built.reports),
        Context.add(ArtworkGate.Service, gate),
      );
    }),
  );
