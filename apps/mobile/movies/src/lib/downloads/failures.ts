import { Data, Predicate } from "effect";

/** What to do after a download call failed. */
export type DownloadStep = Data.TaggedEnum<{
  /** The ticket expired or no longer works: fetch a new one and ask again. */
  Refetch: {};
  /** The media service is busy: ask again in a moment. */
  Wait: {};
  /** Stop and show `message` (H19). */
  Interrupt: { readonly message: string };
}>;

/** Constructors and matchers for `DownloadStep`. */
export const DownloadStep = Data.taggedEnum<DownloadStep>();

/** The line for a server that cannot be reached, as H19 shows it. */
export const SERVER_UNAVAILABLE = "Your server is unavailable.";

/** The line for a download that stopped for no reason a person can act on. */
export const DOWNLOAD_STOPPED = "Download stopped. Try again.";

const LINES = [
  { tag: "TransportError", line: SERVER_UNAVAILABLE },
  { tag: "FileResolverUnavailable", line: SERVER_UNAVAILABLE },
  { tag: "ProtocolError", line: DOWNLOAD_STOPPED },
  { tag: "InsufficientTranscodeSpace", line: "Your server is out of space for this download." },
  { tag: "TranscodeFailed", line: "Your server couldn't prepare this download." },
  { tag: "UnsupportedPlayback", line: "This can't be downloaded at this quality." },
  { tag: "MediaFileNotFound", line: "This file is missing on your server." },
] as const;

/**
 * The step after `cause`, a failure of a core download command or of the media service's
 * download route. A ticket is never renewed: a new one comes from `core.downloads.fetch`.
 */
export const afterDownloadFailure = (cause: unknown): DownloadStep => {
  if (
    Predicate.isTagged(cause, "PlaybackTokenInvalid") ||
    Predicate.isTagged(cause, "PlaybackSessionEnded")
  ) {
    return DownloadStep.Refetch();
  }

  if (Predicate.isTagged(cause, "TranscodeCapacityReached")) return DownloadStep.Wait();

  const known = LINES.find(({ tag }) => Predicate.isTagged(cause, tag));

  if (known !== undefined) return DownloadStep.Interrupt({ message: known.line });

  return DownloadStep.Interrupt({
    message:
      Predicate.hasProperty(cause, "message") &&
      Predicate.isString(cause.message) &&
      cause.message !== ""
        ? cause.message
        : DOWNLOAD_STOPPED,
  });
};

/** The line H19 shows for `cause`; a failure the engine would retry reads as the server's. */
export const failureLine = (cause: unknown): string => {
  const step = afterDownloadFailure(cause);

  return DownloadStep.$is("Interrupt")(step) ? step.message : SERVER_UNAVAILABLE;
};
