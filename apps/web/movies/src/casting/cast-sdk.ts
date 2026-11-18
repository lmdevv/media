/**
 * Loads Google's Cast Web Sender SDK on demand, and only in browsers that can cast with it
 * (Chromium-based ones: Chrome, Edge, Chrome on Android). Other browsers never download it. The
 * script comes from `www.gstatic.com`, which the media service's content security policy allows
 * for scripts and nothing else.
 */
import type { CastFramework, ChromeCast } from "./cast-api";

/** The sender script, which also loads `cast.framework`. */
const CAST_SENDER_URL =
  "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

/** The loaded SDK. */
export interface CastSdk {
  readonly framework: CastFramework;
  readonly cast: ChromeCast;
}

/** Chromium-based browsers (and not Chrome on iOS, which is WebKit) can cast with the SDK. */
export const castCapableBrowser = (userAgent: string): boolean =>
  /\bChrom(?:e|ium)\/\d/u.test(userAgent) && !/\b(?:CriOS|FxiOS|Firefox)\//u.test(userAgent);

/** Both namespaces, once the SDK defined them. */
const loadedSdk = (): CastSdk | null => {
  const framework = window.cast?.framework;
  const cast = window.chrome?.cast;

  return framework === undefined || cast === undefined ? null : { framework, cast };
};

/** The global the SDK calls once it has loaded, with whether casting is available. */
const READY_CALLBACK = "__onGCastApiAvailable";

let loading: Promise<CastSdk | null> | undefined;

/**
 * The Cast SDK, loading it the first time; null in browsers that cannot cast or when the SDK
 * reports casting unavailable or fails to load.
 */
export const loadCastSdk = (): Promise<CastSdk | null> => {
  if (!castCapableBrowser(navigator.userAgent)) return Promise.resolve(null);

  loading ??= new Promise<CastSdk | null>((resolve) => {
    const ready = (available: boolean): void => resolve(available ? loadedSdk() : null);

    Reflect.set(window, READY_CALLBACK, ready);

    const script = document.createElement("script");

    script.src = CAST_SENDER_URL;
    script.async = true;
    script.addEventListener("error", () => resolve(null), { once: true });
    document.head.append(script);
  });

  return loading;
};
