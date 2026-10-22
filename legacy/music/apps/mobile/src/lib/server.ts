/**
 * Finding the [music] server people type in. The address is the one they open in a browser (the
 * image's `PUBLIC_URL`); Convex lives under it at `/convex`, and `/healthz` says whether the
 * server is a [music] server and whether its Convex answers.
 */
import { Option, Schema } from "effect";

/** A server's origin, such as `https://music.example` or `http://192.168.1.4:8090`. */
export const ServerOrigin = Schema.NonEmptyString.pipe(Schema.brand("ServerOrigin"));

/** A server's origin, such as `https://music.example`. */
export type ServerOrigin = typeof ServerOrigin.Type;

/** The Convex deployment behind a server, always its origin plus `/convex`. */
const ConvexUrl = Schema.NonEmptyString.pipe(Schema.brand("ConvexUrl"));

/** The Convex deployment behind a server. */
type ConvexUrl = typeof ConvexUrl.Type;

/** Where this install connects. */
export const ServerConnection = Schema.Struct({ origin: ServerOrigin, convexUrl: ConvexUrl });

/** Where this install connects: the server's origin and the Convex deployment under it. */
export interface ServerConnection extends Schema.Schema.Type<typeof ServerConnection> {}

/** Why connecting to typed text failed. */
export type ConnectFailure =
  /** The text is not an http or https address. */
  | "invalid"
  /** Nothing answered at the address. */
  | "unreachable"
  /** Something answered, but not a [music] server. */
  | "notMusic"
  /** A [music] server answered, but its Convex is down. */
  | "unhealthy";

/** What connecting to typed text found. */
export type ConnectResult =
  | { readonly ok: true; readonly connection: ServerConnection }
  | { readonly ok: false; readonly failure: ConnectFailure };

const hasScheme = /^[a-z][a-z\d+.-]*:\/\//iu;

const makeOrigin = Schema.decodeSync(ServerOrigin);

const makeConvexUrl = Schema.decodeSync(ConvexUrl);

/** The origin of `text` read as a URL, or null when it is not an http or https address. */
const originOf = (text: string): ServerOrigin | null => {
  try {
    const url = new URL(text);

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    return url.host === "" ? null : makeOrigin(url.origin);
  } catch {
    return null;
  }
};

/** Names that only resolve inside a home network or a tailnet. */
const privateName = /(^[^.]+$)|\.(local|lan|home|internal|home\.arpa|ts\.net)$/iu;

/** IPv4 loopback, private, link-local, and carrier-grade NAT (Tailscale) ranges. */
const privateIpv4 =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/u;

/** IPv6 loopback, unique local, and link-local addresses, as `URL` writes them (bracketed). */
const privateIpv6 = /^\[(::1|f[cd][\da-f]{2}:|fe[89ab][\da-f]:)/iu;

/**
 * Whether plain http may be tried for a host typed without a scheme: only hosts on the person's
 * own network or tailnet, where the network itself carries the traffic. A public name gets https
 * alone, so a broken certificate never sends a password in the clear; typing `http://` still
 * reaches any server on purpose.
 */
const mayTryHttp = (hostname: string): boolean =>
  privateName.test(hostname) || privateIpv4.test(hostname) || privateIpv6.test(hostname);

/**
 * The origins to try for typed text, in order. With a scheme, only that one; without, `https`,
 * then `http` for a server on a home network or tailnet, the way home servers often run. Paths
 * are dropped, so a pasted Convex URL such as `https://music.example/convex` connects to its
 * server. Null when the text is not an address.
 */
export const originCandidates = (text: string): ReadonlyArray<ServerOrigin> | null => {
  const trimmed = text.trim();

  if (trimmed === "") return null;

  if (hasScheme.test(trimmed)) {
    const origin = originOf(trimmed);

    return origin === null ? null : [origin];
  }

  const secure = originOf(`https://${trimmed}`);

  if (secure === null) return null;

  return mayTryHttp(new URL(secure).hostname)
    ? [secure, makeOrigin(`http://${secure.slice(8)}`)]
    : [secure];
};

/** The connection for a server origin: Convex is always at `/convex` under it. */
export const connectionFor = (origin: ServerOrigin): ServerConnection => ({
  origin,
  convexUrl: makeConvexUrl(`${origin}/convex`),
});

/** The server's `/healthz` body. It answers 200 only when healthy, 503 otherwise. */
const Health = Schema.Struct({ ok: Schema.Boolean, convex: Schema.Boolean });

const decodeHealth = Schema.decodeUnknownOption(Health);

/** What one origin's health check said. */
type Probe = "healthy" | Exclude<ConnectFailure, "invalid">;

/** The fetch this module calls, so tests can stand up a server in place of the network. */
export type Fetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

const TIMEOUT_MS = 5000;

/**
 * Asks `origin` for its health. Convex being up is enough to connect: accounts and the library
 * work, and a missing ffmpeg shows up later as a playback problem.
 */
const probe = async (origin: ServerOrigin, fetchFn: Fetch): Promise<Probe> => {
  let body: unknown;

  try {
    const response = await fetchFn(`${origin}/healthz`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    body = await response.json();
  } catch (cause) {
    return cause instanceof SyntaxError ? "notMusic" : "unreachable";
  }

  return Option.match(decodeHealth(body), {
    onNone: () => "notMusic",
    onSome: (health) => (health.convex ? "healthy" : "unhealthy"),
  });
};

/** How much each failure says about the address, most first, to report the best one. */
const FAILURE_RANK: ReadonlyArray<Exclude<ConnectFailure, "invalid">> = [
  "unhealthy",
  "notMusic",
  "unreachable",
];

/**
 * Finds the [music] server at typed text. Every candidate is probed at once, so an https port
 * that silently drops packets costs one timeout, not two; the first healthy candidate in order
 * wins, and otherwise the most telling failure is reported.
 */
export const discoverServer = async (text: string, fetchFn: Fetch): Promise<ConnectResult> => {
  const candidates = originCandidates(text);

  if (candidates === null) return { ok: false, failure: "invalid" };

  const probes = await Promise.all(candidates.map((origin) => probe(origin, fetchFn)));
  const healthy = candidates.find((_, index) => probes[index] === "healthy");

  if (healthy !== undefined) return { ok: true, connection: connectionFor(healthy) };

  const failure = FAILURE_RANK.find((kind) => probes.includes(kind)) ?? "unreachable";

  return { ok: false, failure };
};

const FAILURE_LINES = {
  invalid: "Enter your server’s address, such as https://music.example.",
  unreachable: "Your server is out of reach. Check the address and your connection.",
  notMusic: "That address isn’t a [music] server. Use the one you open in your browser.",
  unhealthy: "Your server answered but isn’t ready yet. Make sure [music] is running.",
} as const satisfies Record<ConnectFailure, string>;

/** The line Connect shows under the address for a failure. */
export const describeConnectFailure = (failure: ConnectFailure): string => FAILURE_LINES[failure];

/** A server address as people read it: the host and port, without the scheme. */
export const displayHost = (origin: ServerOrigin): string => origin.replace(hasScheme, "");
