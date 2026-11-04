import type { ClientErrorKind } from "@media/contracts/diagnostics";
import { useReportError } from "@media/sdk/react";
import { useCallback, useEffect } from "react";

import packageJson from "../../package.json" with { type: "json" };

/**
 * Returns a function that writes an unexpected error, caught as `kind` on the current page, to the
 * media service's retained log.
 */
export const useReportAppError = (): ((cause: unknown, kind: ClientErrorKind) => void) => {
  const report = useReportError();

  return useCallback(
    (cause, kind) =>
      report(cause, {
        platform: "web",
        appVersion: packageJson.version,
        kind,
        route: window.location.pathname,
      }),
    [report],
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
