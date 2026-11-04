/**
 * Tickets: the one signed-URL format every byte-serving route accepts. The core issues them; the
 * media server admits them.
 *
 * `t1.<kid>.<aud>.<iat>.<exp>.<purpose>.<kind>.<id>.<principal>.<mac>`, plain ASCII and URL-safe
 * as is. `iat` and `exp` are whole seconds since the epoch, `principal` is `s.<userId>.<sessionId>`
 * for a personal ticket or `a` for a shareable one, and `mac` is unpadded base64url of
 * HMAC-SHA256 over the text before the last `.`, keyed with the raw bytes of the key `kid` names.
 * One claims value has exactly one encoding, so every shareable ticket for one artwork in one
 * bucket is the same string.
 *
 * This module has no imports: Convex functions and the server load the same file, and
 * `TICKET_TEST_VECTORS` pins its bytes.
 */

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

/** Shareable tickets start on these buckets and stay valid for two of them. */
export const SHAREABLE_BUCKET_MS = 7 * 24 * 60 * 60 * 1000;

/** How far ahead of the verifier's clock the issuer's clock may run. */
export const TICKET_CLOCK_SKEW_MS = 60 * 1000;

/** How long a key must stay listed after it last signed: the longest ticket plus the skew. */
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
  readonly resource: TicketResource;
  readonly purpose: TicketPurpose;
  readonly now: number;
  /** Whole milliseconds, at least 1 s. Defaults to and is capped at `PERSONAL_TICKET_MAX_MS`. */
  readonly lifetimeMs?: number;
  /** A ceiling on the expiry, such as the session's own; at least `now` + 1 s. */
  readonly notAfter?: number;
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

/** Reads the state of the session a personal ticket names. A rejection counts as unavailable. */
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

const MIN_LIFETIME_MS = 1000;

const MAC_CHARS = 43;

const MAC_BYTES = 32;

const SECOND_MS = 1000;

/** Keeps every issued `iat` and `exp` inside the format's 12 digits. */
const LATEST_TIME_MS = 10 ** 14;

const KEY_ID = /^[a-z0-9]{1,16}$/u;

const KEY_TEXT = /^[\w-]{43}$/u;

const PRINCIPAL_ID = /^[a-z0-9]{1,64}$/u;

const RESOURCE_ID = /^[\w-]{1,128}$/u;

const TICKET_SYNTAX =
  /^t1\.(?<kid>[a-z0-9]{1,16})\.(?<aud>[a-z]{1,16})\.(?<iat>0|[1-9]\d{0,11})\.(?<exp>0|[1-9]\d{0,11})\.(?<purpose>[a-z]{1,16})\.(?<kind>[a-z]{1,16})\.(?<id>[\w-]{1,128})\.(?:s\.(?<userId>[a-z0-9]{1,64})\.(?<sessionId>[a-z0-9]{1,64})|a)\.(?<mac>[\w-]{43})$/u;

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

/** The bytes of canonical unpadded base64url of exactly `size` bytes, or null. */
const fromCanonicalBase64Url = (text: string, size: number): Uint8Array<ArrayBuffer> | null => {
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

const principalText = (claims: TicketClaims): string =>
  claims.kind === "personal" ? `s.${claims.principal.userId}.${claims.principal.sessionId}` : "a";

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
 * text privately, so the server can check later requests of the same stream against it.
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
    if (!constantTimeEqual(ticket, this.#ticket)) return refused("other_ticket", this.claims);

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
   * Signs a ticket for one auth session. It expires `lifetimeMs` after `now`, at most 6 h later,
   * and never after `notAfter`, rounded down to a whole second.
   *
   * @throws RangeError when an id is outside its alphabet, `now` is not whole milliseconds,
   *   `lifetimeMs` is under 1 s or not whole, or `notAfter` is under `now` + 1 s. The message
   *   names the field, never its value.
   */
  issuePersonal(request: PersonalTicketRequest): Promise<IssuedTicket>;
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
  const signed = ticket.slice(0, ticket.length - MAC_CHARS - 1);

  if (userId !== undefined && sessionId !== undefined) {
    const claims: TicketClaims = {
      kind: "personal",
      principal: { userId, sessionId },
      purpose,
      resource: { kind, id },
      issuedAt,
      expiresAt,
    };

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
  if (!Number.isSafeInteger(value) || value < 0 || value > LATEST_TIME_MS) {
    throw new RangeError(`${field} must be whole milliseconds since the epoch, at most 10^14`);
  }
};

const requireResourceId = (resource: TicketResource): void => {
  if (!RESOURCE_ID.test(resource.id)) {
    throw new RangeError("resource.id must match [\\w-]{1,128}");
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

  const issuePersonal = async (request: PersonalTicketRequest): Promise<IssuedTicket> => {
    const { principal, resource, purpose, now } = request;
    const lifetimeMs = request.lifetimeMs ?? PERSONAL_TICKET_MAX_MS;
    const notAfter = request.notAfter ?? Number.POSITIVE_INFINITY;

    requireWholeTime("now", now);
    requireResourceId(resource);

    if (!PRINCIPAL_ID.test(principal.userId)) {
      throw new RangeError("principal.userId must match [a-z0-9]{1,64}");
    }

    if (!PRINCIPAL_ID.test(principal.sessionId)) {
      throw new RangeError("principal.sessionId must match [a-z0-9]{1,64}");
    }

    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < MIN_LIFETIME_MS) {
      throw new RangeError("lifetimeMs must be a whole number of at least 1000");
    }

    if (Number.isNaN(notAfter) || notAfter < now + MIN_LIFETIME_MS) {
      throw new RangeError("notAfter must be at least now + 1000");
    }

    const end = Math.min(now + Math.min(lifetimeMs, PERSONAL_TICKET_MAX_MS), notAfter);

    return sign({
      kind: "personal",
      principal: { userId: principal.userId, sessionId: principal.sessionId },
      purpose,
      resource: { kind: resource.kind, id: resource.id },
      issuedAt: Math.floor(now / SECOND_MS) * SECOND_MS,
      expiresAt: Math.floor(end / SECOND_MS) * SECOND_MS,
    });
  };

  const issueShareable = async (request: ShareableTicketRequest): Promise<IssuedTicket> => {
    requireWholeTime("now", request.now);
    requireResourceId(request.resource);

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

  const bytes = KEY_TEXT.test(keyText) ? fromCanonicalBase64Url(keyText, TICKET_KEY_BYTES) : null;

  return bytes === null ? new TicketKeysInvalid("key_bytes", position) : { keyId, bytes };
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

  const imported = await Promise.all(
    parsed.map(async ({ keyId, bytes }) => [keyId, await importKey(bytes)] as const),
  );

  const [signing] = imported;

  if (signing === undefined) return { ok: false, error: new TicketKeysInvalid("missing", null) };

  return accepted(makeRing(new Map(imported), signing[0]));
};
