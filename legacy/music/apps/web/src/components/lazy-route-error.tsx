import { CatchBoundary, useLocation } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Suspense } from "react";
import type { ReactNode } from "react";

import { ChunkLoadError, lazyChunk } from "@/lib/lazy-chunk";

// Not TanStack's `lazyRouteComponent`: on a missing module it reloads the page, which stops the
// music and, offline, lands on the browser's error page instead of this app's.
const RouteError = lazyChunk(async () => (await import("./route-error")).RouteError).Component;

const PageNotFound = lazyChunk(async () => (await import("./route-error")).PageNotFound).Component;

/** The plain message, in the entry chunk, for when an error or not-found screen can't show. */
function PlainMessage({ description }: { readonly description: string }) {
  return (
    <div className="flex min-h-dvh-message flex-col items-start justify-center gap-3 px-6 lg:px-12">
      <h1 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
        This screen didn't load
      </h1>
      <p className="max-w-dialog font-sans text-md/md text-text-muted">{description}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="font-sans text-md/md font-semibold text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Reload
      </button>
    </div>
  );
}

const UNREACHABLE = "[music] can't reach the server. Check the connection, then reload the page.";

/**
 * In place of an error or not-found screen that failed: its code couldn't load (offline, or the
 * server was upgraded under an open tab), or it threw. It never rethrows: the next boundary up is
 * the signed-in layout's, which would replace the shell and stop the music, and above the root
 * nothing would catch it at all. React still logs the error.
 */
function Unloaded({ error }: ErrorComponentProps): ReactNode {
  return (
    <PlainMessage
      description={
        error instanceof ChunkLoadError
          ? UNREACHABLE
          : "Something went wrong, and this screen couldn't show it. Reload the page to try again."
      }
    />
  );
}

/**
 * A route's error screen, loaded on demand so it stays out of the entry chunk. If its code can't
 * load, a plain message takes its place instead of a blank page; a new error tries the chunk again.
 */
export function LazyRouteError(props: ErrorComponentProps) {
  return (
    <CatchBoundary getResetKey={() => props.error} errorComponent={Unloaded}>
      <Suspense fallback={null}>
        <RouteError {...props} />
      </Suspense>
    </CatchBoundary>
  );
}

/**
 * The not-found screen, loaded on demand like {@link LazyRouteError}. Each missing address tries the
 * chunk again.
 */
export function LazyPageNotFound() {
  const { pathname } = useLocation();

  return (
    <CatchBoundary getResetKey={() => pathname} errorComponent={Unloaded}>
      <Suspense fallback={null}>
        <PageNotFound />
      </Suspense>
    </CatchBoundary>
  );
}
