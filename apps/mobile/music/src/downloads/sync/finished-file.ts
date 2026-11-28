/**
 * Fetching one finished file: the protocol every downloader shares (phone, desktop, CLI). A
 * stream URL with `&finished=1` answers `503` with `Retry-After` while the media service
 * prepares the file in the background, then the whole file with its length. It never answers
 * with a live encode, which a device couldn't keep.
 */
import { describeFailure } from "@media/mobile-core/failure";
import { Data, Predicate } from "effect";

import { FINISHED_PARAM } from "./models";

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
interface DownloadRequest {
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

/**
 * `transfer`, observing each download with `request`, which starts observing one URL and returns
 * how to tell its outcome: an error status, or null for no answer. A download stopped by its signal
 * tells nothing. `head` goes through `fetch`, which the app observes on its own.
 */
export const observedTransfer = (
  transfer: Transfer,
  request: (url: string) => (status: number | null) => void,
): Transfer => ({
  head: transfer.head,
  download: async (download) => {
    const told = request(download.url);
    const result = await transfer.download(download);

    if (download.signal.aborted) return result;

    DownloadResult.$match(result, {
      Written: () => undefined,
      Refused: ({ status }) => {
        told(status);
      },
      Broken: () => {
        told(null);
      },
    });

    return result;
  },
});

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
   * A stream URL for the song with a fresh download ticket, absolute. Called again once when the
   * media service refuses one (`401`), as it does once a ticket expired.
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

const DEFAULT_RETRY_MS = 3000;

const MIN_RETRY_MS = 1000;

const MAX_RETRY_MS = 30_000;

const MAX_ROUNDS = 400;

const SECONDS = /^\d{1,6}$/u;

const retryAfterMs = (response: Response): number => {
  const header = response.headers.get("Retry-After")?.trim() ?? "";

  if (!SECONDS.test(header)) return DEFAULT_RETRY_MS;

  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Number(header) * 1000));
};

const contentLength = (response: Response): number | null => {
  const header = response.headers.get("Content-Length")?.trim() ?? "";

  return /^\d+$/u.test(header) ? Number(header) : null;
};

const finishedUrl = (url: string): string =>
  `${url}${url.includes("?") ? "&" : "?"}${FINISHED_PARAM}=1`;

const refusal = (status: number): FetchOutcome =>
  status === 404
    ? FetchOutcome.Gone()
    : FetchOutcome.Failed({
        message: `The media service answered ${String(status)}`,
        retryable: status >= 500 || status === 408 || status === 429,
      });

/**
 * Whether the core refused a ticket, as for a song gone or a download limit reached: a tagged
 * failure other than not reaching it. Anything else, such as a lost connection, may pass.
 */
const isRefusal = (cause: unknown): boolean =>
  Predicate.hasProperty(cause, "_tag") &&
  !Predicate.isTagged(cause, "TransportError") &&
  !Predicate.isTagged(cause, "ProtocolError");

const signingFailed = (cause: unknown): FetchOutcome =>
  isRefusal(cause)
    ? FetchOutcome.Failed({ message: describeFailure(cause), retryable: false })
    : FetchOutcome.Failed({ message: "Couldn’t reach the server", retryable: true });

/**
 * Fetches one song's finished file: asks with `HEAD` until the media service has it, then
 * downloads it and checks its length. Asks for a new ticket once when the media service refuses one.
 * Never rejects: every way it ends is a `FetchOutcome`.
 */
export const fetchFinishedFile = async (
  transfer: Transfer,
  request: FinishedFileRequest,
): Promise<FetchOutcome> => {
  const { signal } = request;
  const stopped = (): boolean => signal.aborted;
  let resigned = false;
  let url: string;

  try {
    url = finishedUrl(await request.sign());
  } catch (cause) {
    return stopped() ? FetchOutcome.Stopped() : signingFailed(cause);
  }

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
      return stopped() ? FetchOutcome.Stopped() : signingFailed(cause);
    }
  };

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
        if (status === 503) {
          await request.sleep(DEFAULT_RETRY_MS, signal);

          return null;
        }

        return status === 401 ? resign() : refusal(status);
      },
      Broken: ({ message }) => Promise.resolve(FetchOutcome.Failed({ message, retryable: true })),
    });
  };

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

    if (response.status === 401) return (await resign()) ?? ask(round + 1);

    if (!response.ok) return refusal(response.status);

    return (await download(response)) ?? ask(round + 1);
  };

  try {
    return await ask(0);
  } catch (cause) {
    return stopped()
      ? FetchOutcome.Stopped()
      : FetchOutcome.Failed({
          message: cause instanceof Error ? cause.message : "The download failed",
          retryable: true,
        });
  }
};
