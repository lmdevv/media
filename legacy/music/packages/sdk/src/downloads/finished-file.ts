/**
 * Fetching one finished file: the protocol every downloader shares (phone, desktop, CLI). A
 * stream URL with `&finished=1` answers `503` with `Retry-After` while the media service
 * prepares the file in the background, then the whole file with its length. It never answers
 * with a live encode, which a device couldn't keep.
 */
import { FINISHED_PARAM } from "@music/commands/models";
import { Data } from "effect";

import { commandFailure } from "../errors";
import type { CommandFailure } from "../errors";

/** What a platform's downloader did with one URL. */
export type DownloadResult = Data.TaggedEnum<{
  /** The body is in the file. */
  Written: { readonly bytes: number };
  /** The server answered with an error status. */
  Refused: { readonly status: number };
  /** No answer, or the transfer broke off. */
  Broken: { readonly message: string };
}>;

/** Constructors and matchers for `DownloadResult`. */
export const DownloadResult = Data.taggedEnum<DownloadResult>();

/** One URL to write into one file. */
export interface DownloadRequest {
  readonly url: string;
  /** Where the body goes; a file already there is replaced. */
  readonly destination: string;
  readonly signal: AbortSignal;
}

/** HTTP as a downloading platform offers it: expo-file-system on the phone, Node elsewhere. */
export interface Transfer {
  /** `HEAD url`. Rejects only when no answer came (offline, refused connection, aborted). */
  readonly head: (url: string, signal: AbortSignal) => Promise<Response>;
  /** Writes the body of `url` to a file. */
  readonly download: (request: DownloadRequest) => Promise<DownloadResult>;
}

/** How one fetch of a finished file ended. */
export type FetchOutcome = Data.TaggedEnum<{
  /** The file is at `destination`, `bytes` long, as the server announced. */
  Fetched: {
    readonly destination: string;
    readonly bytes: number;
    readonly contentType: string | null;
  };
  /** The song is gone from the server (`404`): its download will drop it. */
  Gone: {};
  /** Worth another try later when `retryable`; otherwise only something new will change it. */
  Failed: { readonly message: string; readonly retryable: boolean };
  /** The signal aborted. */
  Stopped: {};
}>;

/** Constructors and matchers for `FetchOutcome`. */
export const FetchOutcome = Data.taggedEnum<FetchOutcome>();

/** One song's finished file to fetch. */
export interface FinishedFileRequest {
  /**
   * Signs a stream URL for the song, absolute. Called again once when the media service refuses
   * one (`403`), as it does once a URL expired.
   */
  readonly sign: () => Promise<string>;
  /**
   * The file to write, given the type the server announced, or null when this device can't keep
   * that type.
   */
  readonly destination: (contentType: string | null) => string | null;
  readonly signal: AbortSignal;
  /** Waits `ms`, or less when `signal` aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The wait when `Retry-After` is missing or not whole seconds. */
const DEFAULT_RETRY_MS = 3000;

const MIN_RETRY_MS = 1000;

const MAX_RETRY_MS = 30_000;

/**
 * Answers the server may send while it prepares a file before the fetch gives up for now: about
 * twenty minutes at the server's usual pace, longer than any encode of one song.
 */
const MAX_ROUNDS = 400;

/** A `Retry-After` in whole seconds; the media service never sends the HTTP-date form. */
const SECONDS = /^\d{1,6}$/u;

/** How long a `503` asks to wait, within bounds. */
const retryAfterMs = (response: Response): number => {
  const header = response.headers.get("Retry-After")?.trim() ?? "";

  if (!SECONDS.test(header)) return DEFAULT_RETRY_MS;

  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Number(header) * 1000));
};

/** The announced length, or null without one. */
const contentLength = (response: Response): number | null => {
  const header = response.headers.get("Content-Length")?.trim() ?? "";

  return /^\d+$/u.test(header) ? Number(header) : null;
};

/** `url` asking for the finished file. Signed URLs always carry a query. */
const finishedUrl = (url: string): string =>
  `${url}${url.includes("?") ? "&" : "?"}${FINISHED_PARAM}=1`;

/** The outcome of an error status, other than `403` and `503`, which the fetch handles itself. */
const refusal = (status: number): FetchOutcome =>
  status === 404
    ? FetchOutcome.Gone()
    : FetchOutcome.Failed({
        message: `The media service answered ${String(status)}`,
        retryable: status >= 500 || status === 408 || status === 429,
      });

/**
 * What signing failed with, given the server's refusal if it refused: a refusal stays, a lost
 * connection passes.
 */
const signingFailed = (failure: CommandFailure | null): FetchOutcome =>
  failure === null
    ? FetchOutcome.Failed({ message: "Couldn’t reach the server", retryable: true })
    : FetchOutcome.Failed({ message: failure.message, retryable: false });

/**
 * Fetches one song's finished file: asks with `HEAD` until the media service has it, then
 * downloads it and checks its length. Signs again once when the media service refuses the URL.
 * Never rejects: every way it ends is a `FetchOutcome`.
 */
export const fetchFinishedFile = async (
  transfer: Transfer,
  request: FinishedFileRequest,
): Promise<FetchOutcome> => {
  const { signal } = request;
  // A function, not `signal.aborted`, which the compiler would still think false after awaits.
  const stopped = (): boolean => signal.aborted;
  let resigned = false;
  let url: string;

  try {
    url = finishedUrl(await request.sign());
  } catch (cause) {
    return signingFailed(cause instanceof Error ? commandFailure(cause) : null);
  }

  /** Signs once more after a refusal; null when that worked. */
  const resign = async (): Promise<FetchOutcome | null> => {
    if (resigned) {
      return FetchOutcome.Failed({
        message: "The media service refused the song",
        retryable: false,
      });
    }

    resigned = true;

    try {
      url = finishedUrl(await request.sign());

      return null;
    } catch (cause) {
      return signingFailed(cause instanceof Error ? commandFailure(cause) : null);
    }
  };

  /** Downloads the file the media service has ready; null to ask again. */
  const download = async (response: Response): Promise<FetchOutcome | null> => {
    const contentType = response.headers.get("Content-Type");
    const destination = request.destination(contentType);

    if (destination === null) {
      return FetchOutcome.Failed({
        message: `This device can’t keep ${contentType ?? "this kind of file"}`,
        retryable: false,
      });
    }

    const length = contentLength(response);
    const result = await transfer.download({ url, destination, signal });

    if (stopped()) return FetchOutcome.Stopped();

    return DownloadResult.$match(result, {
      Written: ({ bytes }): Promise<FetchOutcome | null> =>
        Promise.resolve(
          length === null || bytes === length
            ? FetchOutcome.Fetched({ destination, bytes, contentType })
            : FetchOutcome.Failed({
                message: `Got ${String(bytes)} of ${String(length)} bytes`,
                retryable: true,
              }),
        ),
      Refused: async ({ status }) => {
        // The cached file went between the two requests: ask again until it is back.
        if (status === 503) {
          await request.sleep(DEFAULT_RETRY_MS, signal);

          return null;
        }

        return status === 403 ? resign() : refusal(status);
      },
      Broken: ({ message }) => Promise.resolve(FetchOutcome.Failed({ message, retryable: true })),
    });
  };

  /** One question to the media service, then whatever its answer calls for. */
  const ask = async (round: number): Promise<FetchOutcome> => {
    if (round >= MAX_ROUNDS) {
      return FetchOutcome.Failed({
        message: "The server is still preparing the song",
        retryable: true,
      });
    }

    if (stopped()) return FetchOutcome.Stopped();
    let response: Response;

    try {
      response = await transfer.head(url, signal);
    } catch {
      return stopped()
        ? FetchOutcome.Stopped()
        : FetchOutcome.Failed({ message: "Couldn’t reach the media service", retryable: true });
    }

    if (response.status === 503) {
      await request.sleep(retryAfterMs(response), signal);

      return ask(round + 1);
    }

    if (response.status === 403) return (await resign()) ?? ask(round + 1);

    if (!response.ok) return refusal(response.status);

    return (await download(response)) ?? ask(round + 1);
  };

  try {
    return await ask(0);
  } catch (cause) {
    // A platform transfer or destination that threw, rather than answering with a result.
    return stopped()
      ? FetchOutcome.Stopped()
      : FetchOutcome.Failed({
          message: cause instanceof Error ? cause.message : "The download failed",
          retryable: true,
        });
  }
};
