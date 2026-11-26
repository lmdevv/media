/**
 * The app's failed requests to the media service, from wherever they are sent: covers, downloads,
 * the release read. `ServerReachProvider` hears each one that `doubtsMedia` as a doubt for its
 * watch, which a health check then settles. One that comes while no watch listens, as the release
 * read at launch before the session settles, waits for the next watch.
 * Identity: a failure belongs to whichever watch listens when it arrives, or listens next. One
 * from an earlier connection costs the new one a health check and changes nothing on screen,
 * since only failed checks do.
 */

const listeners = new Set<() => void>();

/** A doubt that came while no watch listened. */
let unheard = false;

/**
 * Whether a request to the media service that ended with `status`, null for no answer at all,
 * hints that the service went away: no answer, or an error status from the proxy in front of it
 * or from the service. `503` is the service itself asking to try again later, as while it
 * prepares a file, and a `4xx` is the service answering, as for a cover that isn't there.
 */
export const doubtsMedia = (status: number | null): boolean =>
  status === null || (status >= 500 && status !== 503);

/** Tells the listening watch that a request to the media service ended with `status`. */
export const mediaFailed = (status: number | null): void => {
  if (!doubtsMedia(status)) return;

  unheard = listeners.size === 0;

  for (const listener of listeners) listener();
};

/**
 * Calls `listener` for each failure that doubts the media service, and at once for one no listener
 * heard yet; returns the function that stops it.
 */
export const onMediaDoubt = (listener: () => void): (() => void) => {
  listeners.add(listener);

  if (unheard) {
    unheard = false;
    listener();
  }

  return () => {
    listeners.delete(listener);
  };
};

/** Hears each failure that doubts the media service as a doubt for `watch`; returns the stop. */
export const hearMediaFailures = (watch: {
  readonly hear: (observation: "doubted") => void;
}): (() => void) =>
  onMediaDoubt(() => {
    watch.hear("doubted");
  });

/**
 * The status in a cover's load error, as the image loader words it on iOS: "Download marked as
 * failed because of invalid response status code 404".
 */
const COVER_STATUS = /status code (\d{3})/u;

/** Tells the listening watch that a cover failed to load, from the error `expo-image` reports. */
export const coverFailed = ({ error }: { readonly error: string }): void => {
  const status = COVER_STATUS.exec(error)?.[1];

  mediaFailed(status === undefined ? null : Number(status));
};
