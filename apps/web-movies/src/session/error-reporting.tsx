import type { ClientErrorKind } from "@media/contracts/diagnostics";
import { createMediaServer } from "@media/sdk/promise";
import type { MediaServer, PlatformSdk } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { useCallback, useEffect } from "react";

import { MEDIA_BASE_URL } from "@/env";

import packageJson from "../../package.json" with { type: "json" };

const servers = new WeakMap<PlatformSdk, MediaServer>();

const serverOf = (platform: PlatformSdk): MediaServer => {
  const known = servers.get(platform);

  if (known !== undefined) return known;

  const server = createMediaServer({
    url: MEDIA_BASE_URL,
    accessToken: platform.session.accessToken,
  });

  servers.set(platform, server);

  return server;
};

/**
 * The media server's own routes as the signed-in person, one client per platform client, so every
 * caller shares one repeat window for error reports.
 */
export const useMediaServer = (): MediaServer => serverOf(usePlatform());

/**
 * Returns a function that writes an unexpected error, caught as `kind` on the current page, to the
 * media server's retained log as the signed-in person. It sends nothing while signed out, sends a
 * repeated error once per short window, and never throws.
 */
export const useReportAppError = (): ((cause: unknown, kind: ClientErrorKind) => void) => {
  const server = useMediaServer();

  return useCallback(
    (cause, kind) => {
      void server.reportCaught(cause, {
        platform: "web",
        appVersion: packageJson.version,
        kind,
        route: window.location.pathname,
      });
    },
    [server],
  );
};

/**
 * Reports errors nothing caught: uncaught exceptions and unhandled promise rejections. An error
 * event without an error, such as a cross-origin `Script error.` or Chrome's ResizeObserver loop
 * notice, says nothing to act on and is left out.
 */
export function ReportUnhandledErrors() {
  const report = useReportAppError();

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (event.error !== null && event.error !== undefined) report(event.error, "uncaught");
    };

    const onRejection = (event: PromiseRejectionEvent) =>
      report(event.reason, "unhandled-rejection");

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [report]);

  return null;
}
