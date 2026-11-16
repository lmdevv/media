/**
 * Limits and headers every response carries. Request bodies are capped before anything reads
 * them: Effect reads a body whole and has no limit by default, and the playback routes take JSON
 * from callers that have not proven anything yet. A body must declare its length, which Node's
 * parser then enforces, and stay under the cap; chunked bodies are refused. Responses carry a
 * content security policy and the usual hardening headers; the policy matters for the web app
 * this service serves, whose auth tokens live in `localStorage`, and for library-sourced bytes
 * such as SVG artwork.
 */
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as MediaConfig from "../media-config.ts";

/** The largest request body any route accepts; control and command bodies are a few kilobytes. */
export const MAX_REQUEST_BODY_BYTES = 128 * 1024;

const refuse = (status: 411 | 413, message: string) =>
  Option.some(
    HttpServerResponse.text(message, { status, headers: { "cache-control": "no-store" } }),
  );

const bodyRefusal = (headers: Readonly<Record<string, string | undefined>>) => {
  if (headers["transfer-encoding"] !== undefined) {
    return refuse(411, "Send request bodies with a Content-Length");
  }

  const declared = Number(headers["content-length"] ?? "0");

  return Number.isFinite(declared) && declared <= MAX_REQUEST_BODY_BYTES
    ? Option.none()
    : refuse(413, "The request body is too large");
};

/**
 * The folders Google serves the Cast sender SDK from (`apps/web-movies/src/casting/cast-sdk.ts`):
 * the loader, the framework, and the platform scripts it picks. The image's Caddyfile allows the
 * same folders for the music client, which casts too. Only these, not the whole host, since
 * `www.gstatic.com` also serves script gadgets (old AngularJS bundles) that would turn any HTML
 * injection into script. No scheme: the loader fetches the rest protocol-relative, so a page
 * served over HTTP fetches them over HTTP, and an HTTPS page only over HTTPS.
 */
const CAST_SDK_SOURCES = [
  "www.gstatic.com/cv/js/sender/v1/",
  "www.gstatic.com/cast/sdk/libs/sender/1.0/",
  "www.gstatic.com/eureka/clank/",
].join(" ");

const socketOrigin = (origin: URL): string =>
  `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}`;

const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/**
 * The content security policy for the web app. Scripts come only from this origin (the theme
 * script is a file, not inline) and from the `www.gstatic.com` folders the player loads Google's
 * Cast sender SDK from in Chromium browsers. Styles allow inline `style` attributes and injected
 * `<style>` tags, which the UI kit's toasts and popovers use. The app talks to Convex over HTTP
 * and WebSockets and to this service, plays media from this service and from `blob:` URLs (MSE),
 * and shows TMDB posters while fixing a match. The only frames it embeds are YouTube trailers, from
 * the privacy-enhanced `youtube-nocookie.com` player. Without the public Convex URL the policy
 * allows any HTTP or WebSocket endpoint, which still keeps foreign scripts out.
 */
export const contentSecurityPolicy = (
  config: Pick<MediaConfig.Interface, "mediaBaseUrl" | "convexPublicUrl">,
): string => {
  const media = new URL(config.mediaBaseUrl).origin;

  const convex = Option.match(config.convexPublicUrl, {
    onNone: () => ["http:", "https:", "ws:", "wss:"],
    onSome: (url) => {
      const origin = new URL(url);

      return [origin.origin, socketOrigin(origin)];
    },
  });

  return [
    "default-src 'self'",
    `script-src 'self' ${CAST_SDK_SOURCES}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://image.tmdb.org ${media}`,
    `media-src 'self' blob: ${media}`,
    "font-src 'self' data:",
    `connect-src 'self' ${media} ${convex.join(" ")}`,
    "worker-src 'self' blob:",
    `frame-src ${YOUTUBE_EMBED_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
};

const securityHeaders = (policy: string) => ({
  "content-security-policy": policy,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
});

/** Caps request bodies and adds the security headers to every route, including the HttpApi. */
export const layer: Layer.Layer<never, never, HttpRouter.HttpRouter | MediaConfig.Service> =
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* MediaConfig.Service;
      const headers = securityHeaders(contentSecurityPolicy(config));

      return HttpRouter.middleware(
        (httpEffect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const refused = bodyRefusal(request.headers);

            return Option.isSome(refused) ? refused.value : yield* httpEffect;
          }).pipe(Effect.map(HttpServerResponse.setHeaders(headers))),
        { global: true },
      );
    }),
  );
