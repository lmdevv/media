/** The format version, which is also the first segment of every ticket. */
export const TICKET_VERSION = "t1";

/** The audience every ticket names: the media server. */
export const TICKET_AUDIENCE = "media";

/** The query parameter a ticket travels in. */
export const TICKET_PARAM = "ticket";

/** The setting that holds the key ring, on the core deployment and on the server. */
export const TICKET_KEYS_SETTING = "MEDIA_TICKET_KEYS";

/** The longest a personal ticket can admit a new stream for after it was issued. */
export const PERSONAL_TICKET_MAX_MS = 6 * 60 * 60 * 1000;

/** The shortest lifetime a personal ticket can be issued with. */
export const PERSONAL_TICKET_MIN_MS = 1000;

/** Shareable tickets start on these buckets and stay valid for two of them. */
export const SHAREABLE_BUCKET_MS = 7 * 24 * 60 * 60 * 1000;

/** How far ahead of the verifier's clock the issuer's clock may run. */
export const TICKET_CLOCK_SKEW_MS = 60 * 1000;

/** How long a key must stay listed after it last signed. */
export const TICKET_KEY_RETENTION_MS = 2 * SHAREABLE_BUCKET_MS + TICKET_CLOCK_SKEW_MS;

/** The size of every key, in bytes. */
export const TICKET_KEY_BYTES = 32;

/** The most keys one ring lists. */
export const TICKET_KEYS_MAX = 8;

/** What a ticket lets its holder do: start a stream, download a copy, or load artwork. */
export const ticketPurposes = ["play", "download", "image"] as const;

/** What a ticket lets its holder do. */
export type TicketPurpose = (typeof ticketPurposes)[number];

/** The kinds of resource a ticket can name. */
export const ticketResourceKinds = ["file", "track", "artwork"] as const;

/** A kind of resource a ticket can name. */
export type TicketResourceKind = (typeof ticketResourceKinds)[number];

/**
 * Why a ticket was refused, in the order `admit` checks. `other_ticket` comes only from
 * `TicketAdmission.continue`.
 */
export const ticketRefusalReasons = [
  "malformed",
  "unknown_key",
  "bad_signature",
  "wrong_audience",
  "overlong",
  "wrong_purpose",
  "wrong_resource",
  "not_yet_valid",
  "expired",
  "session_ended",
  "session_unavailable",
  "other_ticket",
] as const;

/** Why a ticket was refused. */
export type TicketRefusalReason = (typeof ticketRefusalReasons)[number];

/** The thing a ticket names, such as a media file or an artwork hash. */
export interface TicketResource {
  readonly kind: TicketResourceKind;
  /** A Convex id or a content hash: `[\w-]{1,128}`. */
  readonly id: string;
}

/** Artwork, the only resource a shareable ticket can name. */
export interface ArtworkResource extends TicketResource {
  readonly kind: "artwork";
}

/** One signed-in auth session. Both ids are Convex ids: `[a-z0-9]{1,64}`. */
export interface SessionPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

/** What an authentic ticket says. Times are milliseconds since the epoch, on whole seconds. */
export type TicketClaims =
  | {
      readonly kind: "personal";
      readonly principal: SessionPrincipal;
      /**
       * The one playback this ticket starts, such as `movies.play.start`'s `playbackId`, so two
       * starts of one item by one session in the same second still get two tickets.
       */
      readonly playback?: string;
      readonly purpose: TicketPurpose;
      readonly resource: TicketResource;
      readonly issuedAt: number;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "shareable";
      readonly purpose: "image";
      readonly resource: ArtworkResource;
      readonly issuedAt: number;
      readonly expiresAt: number;
    };

/** A success value or an expected failure. */
export type TicketResult<A, E extends Error> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

/** What a personal ticket is issued for. Times are milliseconds since the epoch. */
export interface PersonalTicketRequest {
  readonly principal: SessionPrincipal;
  /** The playback the ticket starts: `[a-z0-9-]{1,64}`, signed into the ticket. */
  readonly playback?: string | undefined;
  readonly resource: TicketResource;
  readonly purpose: TicketPurpose;
  readonly now: number;
  /** Whole milliseconds, at least 1 s. Defaults to `PERSONAL_TICKET_MAX_MS`. */
  readonly lifetimeMs?: number | undefined;
  /** A ceiling on the expiry, such as the session's own. */
  readonly notAfter?: number | undefined;
}

/** What a shareable artwork ticket is issued for. */
export interface ShareableTicketRequest {
  readonly resource: ArtworkResource;
  readonly now: number;
}

/** A signed ticket and when it stops admitting, in milliseconds since the epoch. */
export interface IssuedTicket {
  readonly ticket: string;
  readonly expiresAt: number;
}

/** Whether an auth session still holds: as the verifier's host watches it. */
export type SessionState = "live" | "ended" | "unavailable";

/**
 * Reads the state of the session a personal ticket names, as the host's watch on it knows it. It
 * answers `ended` once the session's own expiry passes, which the host enforces on its clock
 * because the core's `sessionStatus` does not rerun as time passes. A rejection counts as
 * unavailable.
 */
export type SessionReader = (principal: SessionPrincipal) => Promise<SessionState>;

/** What a route serves: the purposes it accepts and the resource its path names. */
export interface TicketRoute {
  readonly purposes: ReadonlyArray<TicketPurpose>;
  readonly resource: TicketResource;
}

/** A ticket presented on a route. */
export interface TicketRequest {
  readonly ticket: string;
  readonly route: TicketRoute;
  readonly readSession: SessionReader;
}

/**
 * Why a ticket was refused. Holds neither the ticket text nor key material. `claims` is set once
 * the MAC matched, so the server can log the session without keeping the ticket.
 */
export class TicketRefused extends Error {
  override readonly name = "TicketRefused";
  /** The first check the ticket failed. */
  readonly reason: TicketRefusalReason;
  /** The authentic claims, or `undefined` before the MAC matched. */
  readonly claims: TicketClaims | undefined;

  constructor(reason: TicketRefusalReason, claims?: TicketClaims) {
    super(`Ticket refused: ${reason}`);
    this.reason = reason;
    this.claims = claims;
  }
}

/**
 * Why a personal ticket was not issued: `lifetime` is not a whole number of at least
 * `PERSONAL_TICKET_MIN_MS`, or the `notAfter` ceiling, rounded down to a whole second, leaves
 * less than that (`ends_too_soon`).
 */
export type PersonalTicketProblem = "lifetime" | "ends_too_soon";

/** A personal ticket request the issuer refused. Names the problem, never a value. */
export class PersonalTicketInvalid extends Error {
  override readonly name = "PersonalTicketInvalid";
  /** What is wrong with the request. */
  readonly problem: PersonalTicketProblem;

  constructor(problem: PersonalTicketProblem) {
    super(`Personal ticket not issued: ${problem}`);
    this.problem = problem;
  }
}

/** The kinds of problem a `MEDIA_TICKET_KEYS` value can have. */
export type TicketKeysProblem =
  | "missing"
  | "entry_shape"
  | "key_id"
  | "key_bytes"
  | "duplicate_key_id"
  | "too_many_keys";

/** The key setting cannot be used. Names the problem and the entry, never the text. */
export class TicketKeysInvalid extends Error {
  override readonly name = "TicketKeysInvalid";
  /** What is wrong with the setting. */
  readonly problem: TicketKeysProblem;
  /** The 1-based entry the problem is in, or null when it is in the whole setting. */
  readonly entry: number | null;

  constructor(problem: TicketKeysProblem, entry: number | null) {
    super(
      `${TICKET_KEYS_SETTING} is invalid: ${problem}${entry === null ? "" : ` in entry ${entry}`}`,
    );
    this.problem = problem;
    this.entry = entry;
  }
}

const MAX_TICKET_CHARS = 512;

const MAC_CHARS = 43;

const MAC_BYTES = 32;

const SECOND_MS = 1000;

const TIME_DIGITS = 12;

/** A digit short of the format's limit, so an expiry after it still fits. */
const LATEST_ISSUE_MS = 10 ** (TIME_DIGITS - 1) * SECOND_MS;

const KEY_ID_SOURCE = "[a-z0-9]{1,16}";

const PRINCIPAL_ID_SOURCE = "[a-z0-9]{1,64}";

const RESOURCE_ID_SOURCE = "[\\w-]{1,128}";

const PLAYBACK_ID_SOURCE = "[a-z0-9-]{1,64}";

const MAC_SOURCE = `[\\w-]{${MAC_CHARS}}`;

const WORD_SOURCE = "[a-z]{1,16}";

const TIME_SOURCE = `0|[1-9]\\d{0,${TIME_DIGITS - 1}}`;

const whole = (source: string): RegExp => new RegExp(`^(?:${source})$`, "u");

const KEY_ID = whole(KEY_ID_SOURCE);

const PRINCIPAL_ID = whole(PRINCIPAL_ID_SOURCE);

const RESOURCE_ID = whole(RESOURCE_ID_SOURCE);

const PLAYBACK_ID = whole(PLAYBACK_ID_SOURCE);

const TICKET_SYNTAX = whole(
  [
    TICKET_VERSION,
    `(?<kid>${KEY_ID_SOURCE})`,
    `(?<aud>${WORD_SOURCE})`,
    `(?<iat>${TIME_SOURCE})`,
    `(?<exp>${TIME_SOURCE})`,
    `(?<purpose>${WORD_SOURCE})`,
    `(?<kind>${WORD_SOURCE})`,
    `(?<id>${RESOURCE_ID_SOURCE})`,
    `(?:s\\.(?<userId>${PRINCIPAL_ID_SOURCE})\\.(?<sessionId>${PRINCIPAL_ID_SOURCE})(?:\\.(?<playback>${PLAYBACK_ID_SOURCE}))?|a)`,
    `(?<mac>${MAC_SOURCE})`,
  ].join("\\."),
);

const encoder = new TextEncoder();

/** `bytes` as unpadded base64url. */
export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

/** The `size` bytes `text` holds as canonical unpadded base64url, or null. */
export const fromCanonicalBase64Url = (
  text: string,
  size: number,
): Uint8Array<ArrayBuffer> | null => {
  if (!/^[\w-]*$/u.test(text) || text.length % 4 === 1) return null;

  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);

  return bytes.length === size && toBase64Url(bytes) === text ? bytes : null;
};

const constantTimeEqual = (left: string, right: string): boolean => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
};

const accepted = <A>(value: A): TicketResult<A, never> => ({ ok: true, value });

const refused = (
  reason: TicketRefusalReason,
  claims?: TicketClaims,
): TicketResult<never, TicketRefused> => ({
  ok: false,
  error: new TicketRefused(reason, claims),
});

const principalText = (claims: TicketClaims): string => {
  if (claims.kind === "shareable") return "a";

  const session = `s.${claims.principal.userId}.${claims.principal.sessionId}`;

  return claims.playback === undefined ? session : `${session}.${claims.playback}`;
};

const signedText = (keyId: string, audience: string, claims: TicketClaims): string =>
  [
    TICKET_VERSION,
    keyId,
    audience,
    claims.issuedAt / SECOND_MS,
    claims.expiresAt / SECOND_MS,
    claims.purpose,
    claims.resource.kind,
    claims.resource.id,
    principalText(claims),
  ].join(".");

const readSessionSafely = async (
  readSession: SessionReader,
  principal: SessionPrincipal,
): Promise<SessionState> => {
  try {
    return await readSession(principal);
  } catch {
    return "unavailable";
  }
};

const sessionRefusal = (state: SessionState): TicketRefusalReason | null => {
  if (state === "live") return null;

  return state === "ended" ? "session_ended" : "session_unavailable";
};

const admissionToken: unique symbol = Symbol("TicketAdmission");

/**
 * A ticket `TicketKeyRing.admit` accepted. Only `admit` makes one. It holds the admitted ticket
 * text privately, so the server can check later requests of the same stream against it. The
 * server keeps it with the one stream it started and finds it by that stream's id, never by the
 * ticket, so an expired ticket can only continue a stream that is still running.
 */
export class TicketAdmission {
  /** The admitted ticket's claims. */
  readonly claims: TicketClaims;
  readonly #ticket: string;
  readonly #readSession: SessionReader;

  /** Not for callers: `token` is module-private, so only `TicketKeyRing.admit` can pass it. */
  constructor(
    token: typeof admissionToken,
    ticket: string,
    claims: TicketClaims,
    readSession: SessionReader,
  ) {
    if (token !== admissionToken) throw new TypeError("Only TicketKeyRing.admit makes admissions");

    this.#ticket = ticket;
    this.claims = claims;
    this.#readSession = readSession;
  }

  /**
   * Checks a later request inside the stream this admission started: the same ticket (compared
   * in constant time, else `other_ticket`), a `play` admission (else `wrong_purpose`), and a live
   * session for a personal ticket. Reads neither the clock nor a key, so a stream outlives its
   * ticket's expiry and a key's retirement, but not its session.
   *
   * @returns The admitted claims, or `TicketRefused` carrying them.
   */
  async continue(ticket: string): Promise<TicketResult<TicketClaims, TicketRefused>> {
    if (ticket.length > MAX_TICKET_CHARS || !constantTimeEqual(ticket, this.#ticket)) {
      return refused("other_ticket", this.claims);
    }

    const { claims } = this;

    if (claims.kind === "shareable" || claims.purpose !== "play") {
      return refused("wrong_purpose", claims);
    }

    const reason = sessionRefusal(await readSessionSafely(this.#readSession, claims.principal));

    return reason === null ? accepted(claims) : refused(reason, claims);
  }
}

/** The keys that sign and verify tickets. Holds no key bytes or text. */
export interface TicketKeyRing {
  /** The id of the key that signs: the setting's first entry. */
  readonly signingKeyId: string;
  /** Every listed key id, in setting order. Each verifies. */
  readonly keyIds: ReadonlyArray<string>;
  /**
   * Signs a ticket for one auth session. It expires on the first whole second at least
   * `lifetimeMs` after `now`, but no more than 6 h after the second it was issued in and not after
   * `notAfter`, so it admits for at least `PERSONAL_TICKET_MIN_MS`.
   *
   * @returns The ticket, or `PersonalTicketInvalid` for a lifetime or a ceiling it cannot meet.
   * @throws RangeError when an id is outside its alphabet or `now` is not whole milliseconds. The
   *   message names the field, never its value.
   */
  issuePersonal(
    request: PersonalTicketRequest,
  ): Promise<TicketResult<IssuedTicket, PersonalTicketInvalid>>;
  /**
   * Signs a ticket that names no one, for artwork. Every call in one bucket returns the same
   * string, which admits until the end of the next bucket.
   *
   * @throws RangeError when the artwork id is outside its alphabet or `now` is not whole
   *   milliseconds.
   */
  issueShareable(request: ShareableTicketRequest): Promise<IssuedTicket>;
  /**
   * Checks a ticket that starts something (a stream, a download, an artwork request) at `now`,
   * in the order of `ticketRefusalReasons`. A personal ticket also needs a live session.
   *
   * @returns An admission, or `TicketRefused` with the first reason.
   * @throws RangeError when `now` is not a finite number.
   */
  admit(request: TicketRequest, now: number): Promise<TicketResult<TicketAdmission, TicketRefused>>;
}

interface ParsedTicket {
  readonly keyId: string;
  readonly audience: string;
  readonly claims: TicketClaims;
  readonly signed: string;
  readonly mac: string;
}

const listed = <Name extends string>(
  names: ReadonlyArray<Name>,
  text: string | undefined,
): Name | undefined => names.find((name) => name === text);

const parseTicket = (ticket: string): ParsedTicket | null => {
  if (ticket.length > MAX_TICKET_CHARS) return null;

  const groups = TICKET_SYNTAX.exec(ticket)?.groups;
  const keyId = groups?.["kid"];
  const audience = groups?.["aud"];
  const purpose = listed(ticketPurposes, groups?.["purpose"]);
  const kind = listed(ticketResourceKinds, groups?.["kind"]);
  const id = groups?.["id"];
  const mac = groups?.["mac"];

  if (
    groups === undefined ||
    keyId === undefined ||
    audience === undefined ||
    purpose === undefined ||
    kind === undefined ||
    id === undefined ||
    mac === undefined
  ) {
    return null;
  }

  const issuedAt = Number(groups["iat"]) * SECOND_MS;
  const expiresAt = Number(groups["exp"]) * SECOND_MS;
  const userId = groups["userId"];
  const sessionId = groups["sessionId"];
  const playback = groups["playback"];
  const signed = ticket.slice(0, ticket.length - MAC_CHARS - 1);

  if (userId !== undefined && sessionId !== undefined) {
    const session: TicketClaims = {
      kind: "personal",
      principal: { userId, sessionId },
      purpose,
      resource: { kind, id },
      issuedAt,
      expiresAt,
    };

    const claims = playback === undefined ? session : { ...session, playback };

    return { keyId, audience, claims, signed, mac };
  }

  if (purpose !== "image" || kind !== "artwork") return null;

  const claims: TicketClaims = {
    kind: "shareable",
    purpose,
    resource: { kind, id },
    issuedAt,
    expiresAt,
  };

  return { keyId, audience, claims, signed, mac };
};

const withinCaps = (claims: TicketClaims): boolean =>
  claims.kind === "personal"
    ? claims.expiresAt > claims.issuedAt &&
      claims.expiresAt - claims.issuedAt <= PERSONAL_TICKET_MAX_MS
    : claims.issuedAt % SHAREABLE_BUCKET_MS === 0 &&
      claims.expiresAt === claims.issuedAt + 2 * SHAREABLE_BUCKET_MS;

const clockRefusal = (claims: TicketClaims, now: number): TicketRefusalReason | null => {
  if (claims.issuedAt > now + TICKET_CLOCK_SKEW_MS) return "not_yet_valid";

  return now >= claims.expiresAt ? "expired" : null;
};

const requireWholeTime = (field: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0 || value > LATEST_ISSUE_MS) {
    throw new RangeError(`${field} must be whole milliseconds since the epoch, at most 10^14`);
  }
};

const requireResource = (resource: TicketResource): void => {
  if (listed(ticketResourceKinds, resource.kind) === undefined) {
    throw new RangeError("resource.kind must be one of ticketResourceKinds");
  }

  if (!RESOURCE_ID.test(resource.id)) {
    throw new RangeError(`resource.id must match ${RESOURCE_ID_SOURCE}`);
  }
};

const makeRing = (keys: ReadonlyMap<string, CryptoKey>, signingKeyId: string): TicketKeyRing => {
  const signingKey = keys.get(signingKeyId);

  if (signingKey === undefined) throw new Error("The signing key is missing from its own ring");

  const sign = async (claims: TicketClaims): Promise<IssuedTicket> => {
    const signed = signedText(signingKeyId, TICKET_AUDIENCE, claims);
    const mac = await crypto.subtle.sign("HMAC", signingKey, encoder.encode(signed));

    return { ticket: `${signed}.${toBase64Url(new Uint8Array(mac))}`, expiresAt: claims.expiresAt };
  };

  const issuePersonal = async (
    request: PersonalTicketRequest,
  ): Promise<TicketResult<IssuedTicket, PersonalTicketInvalid>> => {
    const { principal, resource, purpose, now } = request;
    const lifetimeMs = request.lifetimeMs ?? PERSONAL_TICKET_MAX_MS;
    const notAfter = request.notAfter ?? Number.POSITIVE_INFINITY;

    requireWholeTime("now", now);
    requireResource(resource);

    if (listed(ticketPurposes, purpose) === undefined) {
      throw new RangeError("purpose must be one of ticketPurposes");
    }

    if (!PRINCIPAL_ID.test(principal.userId)) {
      throw new RangeError(`principal.userId must match ${PRINCIPAL_ID_SOURCE}`);
    }

    if (!PRINCIPAL_ID.test(principal.sessionId)) {
      throw new RangeError(`principal.sessionId must match ${PRINCIPAL_ID_SOURCE}`);
    }

    const { playback } = request;

    if (playback !== undefined && !PLAYBACK_ID.test(playback)) {
      throw new RangeError(`playback must match ${PLAYBACK_ID_SOURCE}`);
    }

    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < PERSONAL_TICKET_MIN_MS) {
      return { ok: false, error: new PersonalTicketInvalid("lifetime") };
    }

    const issuedAt = Math.floor(now / SECOND_MS) * SECOND_MS;
    const ceiling = Math.floor(notAfter / SECOND_MS) * SECOND_MS;

    if (Number.isNaN(ceiling) || ceiling < now + PERSONAL_TICKET_MIN_MS) {
      return { ok: false, error: new PersonalTicketInvalid("ends_too_soon") };
    }

    const claims: TicketClaims = {
      kind: "personal",
      principal: { userId: principal.userId, sessionId: principal.sessionId },
      purpose,
      resource: { kind: resource.kind, id: resource.id },
      issuedAt,
      expiresAt: Math.min(
        Math.ceil((now + lifetimeMs) / SECOND_MS) * SECOND_MS,
        issuedAt + PERSONAL_TICKET_MAX_MS,
        ceiling,
      ),
    };

    const issued = await sign(playback === undefined ? claims : { ...claims, playback });

    return accepted(issued);
  };

  const issueShareable = async (request: ShareableTicketRequest): Promise<IssuedTicket> => {
    requireWholeTime("now", request.now);
    requireResource(request.resource);

    const issuedAt = Math.floor(request.now / SHAREABLE_BUCKET_MS) * SHAREABLE_BUCKET_MS;

    return sign({
      kind: "shareable",
      purpose: "image",
      resource: { kind: "artwork", id: request.resource.id },
      issuedAt,
      expiresAt: issuedAt + 2 * SHAREABLE_BUCKET_MS,
    });
  };

  const admit = async (
    request: TicketRequest,
    now: number,
  ): Promise<TicketResult<TicketAdmission, TicketRefused>> => {
    if (!Number.isFinite(now)) throw new RangeError("now must be a finite number");

    const parsed = parseTicket(request.ticket);

    if (parsed === null) return refused("malformed");

    const key = keys.get(parsed.keyId);

    if (key === undefined) return refused("unknown_key");

    const mac = fromCanonicalBase64Url(parsed.mac, MAC_BYTES);

    if (mac === null) return refused("malformed");

    if (!(await crypto.subtle.verify("HMAC", key, mac, encoder.encode(parsed.signed)))) {
      return refused("bad_signature");
    }

    const { claims } = parsed;
    const { route } = request;

    if (parsed.audience !== TICKET_AUDIENCE) return refused("wrong_audience", claims);

    if (!withinCaps(claims)) return refused("overlong", claims);

    if (!route.purposes.includes(claims.purpose)) return refused("wrong_purpose", claims);

    if (route.resource.kind !== claims.resource.kind || route.resource.id !== claims.resource.id) {
      return refused("wrong_resource", claims);
    }

    const late = clockRefusal(claims, now);

    if (late !== null) return refused(late, claims);

    if (claims.kind === "personal") {
      const reason = sessionRefusal(await readSessionSafely(request.readSession, claims.principal));

      if (reason !== null) return refused(reason, claims);
    }

    return accepted(
      new TicketAdmission(admissionToken, request.ticket, claims, request.readSession),
    );
  };

  return Object.freeze({
    signingKeyId,
    keyIds: Object.freeze([...keys.keys()]),
    issuePersonal,
    issueShareable,
    admit,
  });
};

const importKey = (bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

type KeyEntry = { readonly keyId: string; readonly bytes: Uint8Array<ArrayBuffer> };

const parseEntry = (entry: string, position: number): KeyEntry | TicketKeysInvalid => {
  const parts = entry.split(":");
  const keyId = parts[0];
  const keyText = parts[1];

  if (parts.length !== 2 || keyId === undefined || keyText === undefined) {
    return new TicketKeysInvalid("entry_shape", position);
  }

  if (!KEY_ID.test(keyId)) return new TicketKeysInvalid("key_id", position);

  const bytes = fromCanonicalBase64Url(keyText, TICKET_KEY_BYTES);

  return bytes === null ? new TicketKeysInvalid("key_bytes", position) : { keyId, bytes };
};

/** The entries of a `MEDIA_TICKET_KEYS` value, in setting order, or the first problem. */
const parseRing = (text: string): TicketResult<ReadonlyArray<KeyEntry>, TicketKeysInvalid> => {
  if (text === "") return { ok: false, error: new TicketKeysInvalid("missing", null) };

  const entries = text.split(",");

  if (entries.length > TICKET_KEYS_MAX) {
    return { ok: false, error: new TicketKeysInvalid("too_many_keys", null) };
  }

  const parsed: Array<KeyEntry> = [];

  for (const [index, entry] of entries.entries()) {
    const key = parseEntry(entry, index + 1);

    if (key instanceof TicketKeysInvalid) return { ok: false, error: key };

    if (parsed.some(({ keyId }) => keyId === key.keyId)) {
      return { ok: false, error: new TicketKeysInvalid("duplicate_key_id", index + 1) };
    }

    parsed.push(key);
  }

  return accepted(parsed);
};

/**
 * Reads a `MEDIA_TICKET_KEYS` value: `<kid>:<key>[,<kid>:<key>]…`, no spaces, 1 to 8 entries with
 * unique kids of `[a-z0-9]{1,16}`, each key the unpadded base64url of 32 random bytes. The first
 * entry signs; every entry verifies. Keys are imported as non-extractable HMAC keys.
 *
 * @returns The ring, or `TicketKeysInvalid` naming the problem and the entry, never the text.
 */
export const loadTicketKeyRing = async (
  text: string,
): Promise<TicketResult<TicketKeyRing, TicketKeysInvalid>> => {
  const parsed = parseRing(text);

  if (!parsed.ok) return parsed;

  const imported = await Promise.all(
    parsed.value.map(async ({ keyId, bytes }) => [keyId, await importKey(bytes)] as const),
  );

  const [signing] = imported;

  if (signing === undefined) return { ok: false, error: new TicketKeysInvalid("missing", null) };

  return accepted(makeRing(new Map(imported), signing[0]));
};

/**
 * The id a shareable ticket names for the artwork at `key` (ADR 0011): the unpadded base64url of
 * the key's SHA-256, 43 characters, since a key can be longer than a ticket's resource id allows.
 * The core issues tickets for this id, and the server's artwork route admits them for it.
 */
export const artworkTicketId = async (key: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));

  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

/** HMAC keys derived from a ticket key ring for another purpose. Holds no key bytes or text. */
export interface DerivedKeyRing {
  /** The id of the key that signs: the ring's first entry. */
  readonly signingKeyId: string;
  /** Each listed key id with its derived key. Each verifies. */
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

/**
 * Reads a `MEDIA_TICKET_KEYS` value as `loadTicketKeyRing` does and derives one HMAC-SHA256 key per
 * entry for the purpose `label` names: the HMAC of `label` under the entry's key. A derived key
 * never signs a ticket, and a ticket key never signs what a derived key signs, so the ring serves
 * a second purpose without a second setting, and rotates with the tickets'.
 *
 * @returns The derived keys, or `TicketKeysInvalid` as `loadTicketKeyRing` answers it.
 */
export const loadDerivedKeyRing = async (
  text: string,
  label: string,
): Promise<TicketResult<DerivedKeyRing, TicketKeysInvalid>> => {
  const parsed = parseRing(text);

  if (!parsed.ok) return parsed;

  const derived = await Promise.all(
    parsed.value.map(async ({ keyId, bytes }) => {
      const parent = await importKey(bytes);
      const derivedBytes = await crypto.subtle.sign("HMAC", parent, encoder.encode(label));

      return [keyId, await importKey(new Uint8Array(derivedBytes))] as const;
    }),
  );

  const [signing] = derived;

  if (signing === undefined) return { ok: false, error: new TicketKeysInvalid("missing", null) };

  return accepted(Object.freeze({ signingKeyId: signing[0], keys: new Map(derived) }));
};
