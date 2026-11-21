import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as MediaConfig from "../media-config.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";

const REVALIDATE = "no-cache";

const SHORT = "public, max-age=3600";

/**
 * Content types for files the app ships whose extension Effect's table does not know, which it
 * would send as `application/octet-stream`; the security headers forbid sniffing.
 */
const EXTRA_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([[".ico", "image/x-icon"]]);

const isWithin = (root: string, candidate: string, separator: string): boolean =>
  candidate === root ||
  candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

const decodeComponent = Option.liftThrowable(decodeURIComponent);

const notFound = HttpServerResponse.text("Not found", {
  status: 404,
  headers: { "cache-control": "no-store" },
});

/** Adds the web app route when `WEB_DIST_DIR` is configured. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
  | HttpPlatform.HttpPlatform
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    if (Option.isNone(config.webDistDir)) return;
    const router = yield* HttpRouter.HttpRouter;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HttpPlatform.HttpPlatform;
    const root = config.webDistDir.value;

    const serve = (file: string, cacheControl: string) => {
      const contentType = EXTRA_CONTENT_TYPES.get(path.extname(file).toLowerCase());

      return platform.fileResponse(file, {
        headers:
          contentType === undefined
            ? { "cache-control": cacheControl }
            : { "cache-control": cacheControl, "content-type": contentType },
      });
    };

    const fileInside = (relative: string) =>
      Effect.gen(function* () {
        const realRoot = yield* fs.realPath(root);
        const real = yield* fs.realPath(path.join(root, relative));

        if (!isWithin(realRoot, real, path.sep)) return Option.none<string>();
        const info = yield* fs.stat(real);

        return info.type === "File" ? Option.some(real) : Option.none<string>();
      }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = new URL(request.url, "http://web.invalid").pathname;
      const decoded = decodeComponent(pathname);

      if (Option.isNone(decoded) || decoded.value.includes("\u0000")) return notFound;

      if (/^\/(?:api|media)(?:\/|$)/.test(decoded.value)) return notFound;
      const relative = path.normalize(decoded.value).replace(/^[/\\]+/, "");

      if (relative.startsWith("..")) return notFound;

      const found = relative === "" ? Option.none<string>() : yield* fileInside(relative);

      if (Option.isSome(found)) {
        const cacheControl = relative.startsWith("assets/")
          ? IMMUTABLE
          : relative === "index.html"
            ? REVALIDATE
            : SHORT;

        return yield* serve(found.value, cacheControl);
      }

      const accept = request.headers["accept"] ?? "";

      if (
        path.extname(relative) !== "" ||
        (relative !== "" && !accept.includes("text/html") && !accept.includes("*/*"))
      ) {
        return notFound;
      }

      const index = yield* fileInside("index.html");

      return Option.isSome(index) ? yield* serve(index.value, REVALIDATE) : notFound;
    }).pipe(
      Effect.orElseSucceed(() => notFound),
      Effect.withSpan("WebApp.serve"),
    );

    yield* router.add("GET", "/*", handler);
  }),
);
