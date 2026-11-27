import { Option } from "effect";

/**
 * The app's requests to the media service, observed for the reach watch. A failed one is a doubt,
 * which the watch settles with a health check.
 *
 * Every JavaScript `fetch` is observed while a watch listens (`listenForMediaRequests`), whoever
 * sends it, but the health check, which the watch asks itself. The release read `followServer`
 * makes again reports through `releaseReread`. Native code reports from the event it gives: the
 * player's audio items, file downloads, and cover images call `mediaRequest` when the request
 * starts and its result when it ends.
 *
 * Identity: a request belongs to the watch that listened when it started. Its failure reaches that
 * watch only while it still listens, and only for a path of the media service on that watch's
 * server. A watch listens for one connection and one sign-in, so a request from an earlier
 * connection, server, or session changes nothing.
 */

/** Hears the doubts of one watch. */
interface Listener {
  readonly origin: string;
  readonly hear: (observation: "doubted") => void;
  /** The covers whose failure this watch heard; each is heard once. */
  readonly covers: Set<string>;
}

let listening: Listener | null = null;

/** The core's own paths on the same origin; its socket and calls speak for it. */
const CORE_PATH = "/convex";

/** The health check: the watch asks it itself, and hears its answer as a check. */
const HEALTH_PATH = "/api/health";

/**
 * Whether a request to the media service that ended with `status`, null for no answer at all,
 * hints that the service went away: no answer, or an error status from the proxy in front of it
 * or from the service. `503` is the service itself asking to try again later, as while it
 * prepares a file, and a `4xx` is the service answering, as for a cover that isn't there.
 */
export const doubtsMedia = (status: number | null): boolean =>
  status === null || (status >= 500 && status !== 503);

/** `url`'s origin and path, or null when it isn't a URL. */
const partsOf = (url: string): { readonly origin: string; readonly pathname: string } | null => {
  try {
    const { origin, pathname } = new URL(url);

    return { origin, pathname };
  } catch {
    return null;
  }
};

/** The listener `url` belongs to: a path of the media service on its server; null for none. */
const ownerOf = (url: string): Listener | null => {
  const parts = listening === null ? null : partsOf(url);

  if (listening === null || parts === null || parts.origin !== listening.origin) return null;
  const { pathname } = parts;

  return pathname === CORE_PATH || pathname.startsWith(`${CORE_PATH}/`) || pathname === HEALTH_PATH
    ? null
    : listening;
};

/**
 * Starts observing one request to `url`; returns the function that tells how it ended, with its
 * status, or null for no answer. `once` names a request whose failure with no status, which may be
 * a broken file rather than the service, the watch hears only once; one with a status it counts is
 * heard every time.
 */
export const mediaRequest = (url: string, once?: string): ((status: number | null) => void) => {
  const owner = ownerOf(url);

  return (status) => {
    if (owner === null || owner !== listening || !doubtsMedia(status)) return;

    if (once !== undefined && status === null) {
      if (owner.covers.has(once)) return;
      owner.covers.add(once);
    }

    owner.hear("doubted");
  };
};

const urlOf = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : String(input);

/** Names the `fetch` each observer wraps, on the global itself, which every copy of this module shares. */
const SENDS: unique symbol = Symbol.for("lar.music.mediaRequests.sends");

type ObservingFetch = typeof fetch & { readonly [SENDS]: typeof fetch };

const isObserving = (send: typeof fetch): send is ObservingFetch => SENDS in send;

/** This copy's observing `fetch`, while it is on the global; null otherwise. */
let observing: ObservingFetch | null = null;

/**
 * Puts this copy's observing `fetch` on the global, around the `fetch` that was there first, in
 * place of any other copy's, as a fast refresh loads the module again: one wrapper at most.
 */
const observeFetch = (): void => {
  const current = globalThis.fetch;

  if (current === observing) return;
  const send = isObserving(current) ? current[SENDS] : current;

  const observe = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const told = mediaRequest(urlOf(input));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);

    try {
      const response = await send(input, init);

      if (!response.ok && signal?.aborted !== true) told(response.status);

      return response;
    } catch (error) {
      if (signal?.aborted !== true) told(null);

      throw error;
    }
  };

  observing = Object.assign(observe, { [SENDS]: send });
  globalThis.fetch = observing;
};

/** Gives the global back the `fetch` this copy wrapped, unless another copy's wrapper replaced it. */
const stopObservingFetch = (): void => {
  if (observing !== null && globalThis.fetch === observing) globalThis.fetch = observing[SENDS];
  observing = null;
};

/**
 * Has `watch` hear the failed requests to the media service at `mediaUrl` that start from now on;
 * returns the function that stops it. Requests started for an earlier listener stay its own.
 */
export const listenForMediaRequests = (
  mediaUrl: string,
  watch: { readonly hear: (observation: "doubted") => void },
): (() => void) => {
  observeFetch();

  const listener: Listener = {
    origin: new URL(mediaUrl).origin,
    hear: watch.hear,
    covers: new Set(),
  };

  listening = listener;

  return () => {
    if (listening !== listener) return;
    listening = null;
    stopObservingFetch();
  };
};

/**
 * The status in a cover's load error, as the image loader words it on iOS: "Download marked as
 * failed because of invalid response status code 404".
 */
const COVER_STATUS = /status code (\d{3})/u;

/** One doubt per cover per watch: its URL without the ticket names it. */
const coverRequest = (url: string): ((status: number | null) => void) =>
  mediaRequest(url, url.split("?")[0] ?? url);

/**
 * Starts observing the cover image at `url`; returns its `onError`, which reads the status from
 * the error `expo-image` reports.
 */
export const coverFailed = (url: string): ((event: { readonly error: string }) => void) => {
  const told = coverRequest(url);

  return ({ error }) => {
    const status = COVER_STATUS.exec(error)?.[1];

    told(status === undefined ? null : Number(status));
  };
};

/**
 * Starts observing a read of the cover at `url` that reports no status when it fails, as the
 * player's tint does; returns its `catch`, which answers null.
 */
export const coverUnread = (url: string): (() => null) => {
  const told = coverRequest(url);

  return () => {
    told(null);

    return null;
  };
};

/**
 * Starts observing a read of the release that `followServer` makes again after an answer the app
 * couldn't read; returns how to tell what it read. Its failure reaches the watch that listened when
 * it started, while it still listens. The watch's own checks never come this way, so none counts
 * twice.
 */
export const releaseReread = (): ((health: Option.Option<unknown>) => void) => {
  const owner = listening;

  return (health) => {
    if (owner !== null && owner === listening && Option.isNone(health)) owner.hear("doubted");
  };
};

/**
 * The release read's doubt at launch, kept for the connection's first watch: the read goes out
 * before the session settles and any watch listens. A later watch of the connection, as after a
 * sign-out, never hears it, nor does the first once it closed.
 */
export interface LaunchDoubt {
  /** The release read at launch went unanswered. */
  readonly failed: () => void;
  /** Has `watch` hear the doubt, now or when it comes, if no watch took it before. */
  readonly take: (watch: { readonly hear: (observation: "doubted") => void }) => () => void;
}

/** A `LaunchDoubt` for one connection. */
export const launchDoubt = (): LaunchDoubt => {
  let failed = false;
  let taken = false;
  let hear: ((observation: "doubted") => void) | null = null;

  return {
    failed: () => {
      if (taken) hear?.("doubted");
      else failed = true;
    },
    take: (watch) => {
      if (taken) return () => undefined;
      taken = true;

      if (failed) watch.hear("doubted");
      else hear = watch.hear;

      return () => {
        hear = null;
      };
    },
  };
};
