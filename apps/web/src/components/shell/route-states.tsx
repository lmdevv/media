import { useAuth, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { cn } from "@media/ui/lib/utils";
import { Link, useMatches, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";

import { AuthPage } from "@/components/auth/auth-page";
import { useReportAppError } from "@/session/error-reporting";

const InShellContext = createContext(false);

/** Marks `children` as rendered inside the app shell, which already draws the top bar. */
export function InShell({ children }: { readonly children: ReactNode }) {
  return <InShellContext.Provider value>{children}</InShellContext.Provider>;
}

function StateFrame({ children }: { readonly children: ReactNode }) {
  const inShell = useContext(InShellContext);

  const hero = useMatches({
    select: (matches) => matches.some((match) => match.staticData.hero === true),
  });

  if (!inShell) {
    return (
      <AuthPage width="dialog" offset="lead">
        {children}
      </AuthPage>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-[60svh] flex-col items-center justify-center gap-8 px-6",
        hero && "md:pt-17",
      )}
    >
      {children}
    </div>
  );
}

const goHome = (variant: "primary" | "subtle") => (
  <Link to="/" className={buttonVariants({ variant })}>
    Go home
  </Link>
);

const errorText = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);

  return cause.stack ?? `${cause.name}: ${cause.message}`;
};

/** An address no route serves, such as a mistyped or outdated link. */
export function NotFoundPage() {
  return (
    <StateFrame>
      <title>Not found · [movies]</title>
      <CalmState title="This page isn't here" actions={goHome("primary")} />
    </StateFrame>
  );
}

/**
 * A route that threw while rendering. Try again renders it afresh; people who manage the server
 * can open the error itself, which is also written to the server's log.
 */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const report = useReportAppError();
  const { status } = useAuth();
  const viewer = useCommandQuery("account.viewer", status === "signedIn" ? {} : "skip");
  const canManage = viewer.status === "success" && viewer.data.scopes.includes("manage");

  useEffect(() => report(error, "route"), [error, report]);

  return (
    <StateFrame>
      <CalmState
        title="Something went wrong"
        actions={
          <>
            <Button
              onClick={() => {
                reset();
                void router.invalidate();
              }}
            >
              Try again
            </Button>
            {goHome("subtle")}
          </>
        }
      />
      {canManage ? (
        <details className="mx-auto w-full max-w-130 font-sans">
          <summary className="cursor-pointer text-center text-label/label text-text-muted">
            Error details
          </summary>
          <pre className="mt-3 max-h-60 overflow-auto rounded-control bg-surface p-4 font-mono text-caption/caption whitespace-pre-wrap text-text-muted">
            {errorText(error)}
          </pre>
        </details>
      ) : null}
    </StateFrame>
  );
}
