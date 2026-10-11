import { Option, Schema } from "effect";

/** The global that `/config.js` sets; the container image serves that script before the app. */
const RUNTIME_CONFIG = "__MUSIC_CONFIG__";

declare global {
  interface Window {
    /** Runtime configuration from `/config.js`; null or absent outside the container image. */
    [RUNTIME_CONFIG]?: { readonly convexUrl?: string } | null | undefined;
  }
}

const Url = Schema.NonEmptyString.check(Schema.isPattern(/^https?:\/\//));

const decodeUrl = Schema.decodeUnknownOption(Url);

/**
 * The Convex deployment URL, in priority order: runtime config from `/config.js`, then the
 * `VITE_CONVEX_URL` build variable, then `/convex` on the page's own origin.
 */
export const resolveConvexUrl = (): string =>
  Option.getOrElse(
    Option.orElse(decodeUrl(window[RUNTIME_CONFIG]?.convexUrl), () =>
      decodeUrl(import.meta.env["VITE_CONVEX_URL"]),
    ),
    () => `${window.location.origin}/convex`,
  );
