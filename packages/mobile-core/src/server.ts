import {
  ClientConfigResponse,
  HealthResponse,
  MEDIA_ROUTES,
} from "@media/contracts/media-playback";
import { Option, Schema } from "effect";

/** Where this install connects. */
export interface ServerConnection {
  /** The media service, such as `https://cinema.home`, which also takes every sign-in. */
  readonly mediaUrl: string;
  /** The core's Convex deployment, such as `https://cinema.home/convex`. */
  readonly convexUrl: string;
  /** The movies web client, such as `https://cinema.home/movies`, for links the apps share. */
  readonly moviesUrl: string;
}

/** Why connecting to an address failed. */
export type ConnectFailure =
  /** The text is not an address. */
  | "invalid"
  /** Nothing answered, or it answered but is not a [media] server. */
  | "unreachable"
  /**
   * A [media] server that does not say where its account server is (no public Convex URL
   * configured, or a version without `/api/client-config`); Connection Details still works.
   */
  | "needsDetails"
  /** The media service answered and named its account server, but that address doesn't answer. */
  | "accountsUnreachable";

const hasSchemePrefix = /^[a-z][a-z\d+.-]*:\/\//iu;

/**
 * Turns typed text into a base URL: trims it, adds `https://` when no scheme is given, and drops
 * trailing slashes. Null when it is not an http or https URL.
 */
export const normalizeServerUrl = (text: string): string | null => {
  const trimmed = text.trim();

  if (trimmed === "") return null;

  const withScheme = hasSchemePrefix.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
  } catch {
    return null;
  }
};

const TIMEOUT_MS = 5000;

const getDecoded = async <A>(
  url: string,
  schema: Schema.Codec<A, unknown>,
): Promise<Option.Option<A>> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

    return response.ok
      ? Schema.decodeUnknownOption(Schema.toCodecJson(schema))(await response.json())
      : Option.none();
  } catch {
    return Option.none();
  }
};

/** What connecting to an address found. */
export type ConnectResult =
  | { readonly ok: true; readonly connection: ServerConnection }
  | { readonly ok: false; readonly failure: ConnectFailure };

const convexAnswers = async (convexUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${convexUrl}/version`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    return response.ok;
  } catch {
    return false;
  }
};

/** The health of the [media] server at `mediaUrl`, or none when it does not answer. */
export const readHealth = (mediaUrl: string): Promise<Option.Option<HealthResponse>> =>
  getDecoded(`${mediaUrl}${MEDIA_ROUTES.health}`, HealthResponse);

const mediaAnswers = async (mediaUrl: string): Promise<boolean> =>
  Option.isSome(await readHealth(mediaUrl));

const candidatesFor = (text: string): ReadonlyArray<string> | null => {
  const normalized = normalizeServerUrl(text);

  if (normalized === null) return null;

  return hasSchemePrefix.test(text.trim())
    ? [normalized]
    : [normalized, normalized.replace(/^https:/u, "http:")];
};

const firstAnswering = async (
  candidates: ReadonlyArray<string>,
  answers: (url: string) => Promise<boolean>,
): Promise<string | null> => {
  const probes = candidates.map(answers);

  const from = async (index: number): Promise<string | null> => {
    const candidate = candidates[index];
    const probe = probes[index];

    if (candidate === undefined || probe === undefined) return null;

    return (await probe) ? candidate : from(index + 1);
  };

  return from(0);
};

const authorityPattern = /^(https?:\/\/)(\[[^\]]+\]|[^:/]+)(:\d+)?(.*)$/u;

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || host.startsWith("127.");

/**
 * An address the server advertised, as this phone reaches it. A server that names a loopback
 * address, like the Compose default `http://localhost:3210`, means the machine its media service
 * runs on, so the host becomes the media service's and the scheme, port, and path stay.
 */
export const reachableUrl = (convexUrl: string, mediaUrl: string): string => {
  const convex = authorityPattern.exec(convexUrl);
  const media = authorityPattern.exec(mediaUrl);
  const convexHost = convex?.[2];
  const mediaHost = media?.[2];

  if (convex === null || convexHost === undefined || mediaHost === undefined) return convexUrl;

  if (!isLoopback(convexHost) || isLoopback(mediaHost)) return convexUrl;

  return `${convex[1] ?? ""}${mediaHost}${convex[3] ?? ""}${convex[4] ?? ""}`;
};

/** The movies web client beside the media service at `mediaUrl`, where installs serve it. */
export const moviesUrlBeside = (mediaUrl: string): string => `${mediaUrl}/movies`;

/**
 * Checks that `text` is a [media] server, asks its `/api/client-config` where the core and the
 * movies web client live, and probes the core.
 */
export const discoverServer = async (text: string): Promise<ConnectResult> => {
  const candidates = candidatesFor(text);

  if (candidates === null) return { ok: false, failure: "invalid" };

  const configs = candidates.map((url) =>
    getDecoded(`${url}${MEDIA_ROUTES.clientConfig}`, ClientConfigResponse),
  );

  const mediaUrl = await firstAnswering(candidates, mediaAnswers);
  const config = configs[candidates.findIndex((url) => url === mediaUrl)];

  if (mediaUrl === null || config === undefined) return { ok: false, failure: "unreachable" };

  const answered = await config;

  const advertised = Option.flatMapNullishOr(answered, (value) =>
    normalizeServerUrl(value.convexUrl ?? ""),
  );

  if (Option.isNone(advertised)) return { ok: false, failure: "needsDetails" };

  const convexUrl = reachableUrl(advertised.value, mediaUrl);

  const moviesUrl = Option.match(
    Option.flatMapNullishOr(answered, (value) => normalizeServerUrl(value.moviesUrl ?? "")),
    {
      onNone: () => moviesUrlBeside(mediaUrl),
      onSome: (advertisedMovies) => reachableUrl(advertisedMovies, mediaUrl),
    },
  );

  return (await convexAnswers(convexUrl))
    ? { ok: true, connection: { mediaUrl, convexUrl, moviesUrl } }
    : { ok: false, failure: "accountsUnreachable" };
};

/**
 * Checks both addresses typed on Connection Details: the media service must answer its health
 * check and the account server its version endpoint. Each address without a scheme tries https,
 * then http.
 */
export const connectManually = async (
  mediaText: string,
  convexText: string,
): Promise<ConnectResult> => {
  const mediaCandidates = candidatesFor(mediaText);
  const convexCandidates = candidatesFor(convexText);

  if (mediaCandidates === null || convexCandidates === null) {
    return { ok: false, failure: "invalid" };
  }

  const [mediaUrl, convexUrl] = await Promise.all([
    firstAnswering(mediaCandidates, mediaAnswers),
    firstAnswering(convexCandidates, convexAnswers),
  ]);

  if (mediaUrl === null) return { ok: false, failure: "unreachable" };

  if (convexUrl === null) return { ok: false, failure: "accountsUnreachable" };

  return { ok: true, connection: { mediaUrl, convexUrl, moviesUrl: moviesUrlBeside(mediaUrl) } };
};

const FAILURE_LINES = {
  invalid: "Enter a server address, such as https://cinema.home.",
  unreachable: "Can't reach a [media] server at that address.",
  needsDetails: "This server doesn't share its account server. Enter its connection details.",
  accountsUnreachable: "Can't reach this server's account server. Check its connection details.",
} as const satisfies Record<ConnectFailure, string>;

/** The line each failure shows under the field. */
export const describeConnectFailure = (failure: ConnectFailure): string => FAILURE_LINES[failure];
