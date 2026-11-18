import { MUSIC, hostName, useMusicSession } from "@media/player/session-react";
import { usePlatform } from "@media/sdk/react";
import { isFailure } from "@media/ui/lib/failure";
import { Link, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ENDED, parseJamLink } from "@/components/jam/jam";
import { buttonClassName } from "@/components/ui/button";
import { describeFailure } from "@/lib/action";

/**
 * A Jam's link, `/jam#<link>`: the link travels after `#`, so no request or referrer carries it,
 * and it leaves the address and history once read. The page joins through it and goes home, where
 * the Jam band shows the Jam and the player follows it;
 * or it says why it cannot: waiting for the host, or a locked, ended, or unknown Jam.
 */
export const Route = createFileRoute("/_app/jam")({
  head: () => ({ meta: [{ title: "Jam · Lar Music" }] }),
  component: JamPage,
});

interface Notice {
  readonly title: string;
  readonly lead: string | null;
}

type Joining = { readonly kind: "none" | "joining" } | ({ readonly kind: "refused" } & Notice);

const refusalOf = (cause: unknown): Extract<Joining, { readonly kind: "refused" }> => {
  if (isFailure(cause, "Expired")) {
    return {
      kind: "refused",
      title: "This Jam has ended",
      lead: "The host ended it, or it went quiet. Ask them to start a new one.",
    };
  }

  if (isFailure(cause, "NotFound")) {
    return {
      kind: "refused",
      title: "This Jam link doesn't work",
      lead: "Ask the host for the current one.",
    };
  }

  const message = describeFailure(cause);

  return /locked/iu.test(message)
    ? {
        kind: "refused",
        title: "This Jam is locked",
        lead: "The host isn't letting anyone new in right now.",
      }
    : { kind: "refused", title: "You couldn't join this Jam", lead: message };
};

function JamPage() {
  const platform = usePlatform();
  const navigate = useNavigate();
  const { view } = useMusicSession();
  const link = parseJamLink(useLocation({ select: (location) => location.hash }));
  const [taken, setTaken] = useState<string | null>(null);
  const [joining, setJoining] = useState<Joining>({ kind: link === null ? "none" : "joining" });

  // A link opened while on this page, such as from the address bar, joins as well.
  if (link !== null && link !== taken) {
    setTaken(link);
    setJoining({ kind: "joining" });
  }

  useEffect(() => {
    if (taken === null) return undefined;

    let active = true;

    // Out of the address and history at once; the router keeps it, so the join runs only once.
    window.history.replaceState(window.history.state, "", window.location.pathname);

    platform.core.together.join({ domain: MUSIC, link: taken }).then(
      ({ state }) => {
        if (!active) return undefined;

        toast.success(state === "pending" ? "Asked the host to let you in" : "You're in the Jam");

        return navigate({ to: "/", replace: true });
      },
      (cause: unknown) => {
        if (active) setJoining(refusalOf(cause));
      },
    );

    return () => {
      active = false;
    };
  }, [platform, taken, navigate]);

  const notice = (): Notice | null => {
    if (joining.kind === "refused") return joining;

    if (joining.kind === "joining") return null;

    if (view?.state === "pending") {
      return {
        title: `Waiting to join ${hostName(view)}'s Jam`,
        lead: "Your own music keeps playing until they let you in.",
      };
    }

    if (view?.state === "ended") return { title: "The Jam ended", lead: ENDED[view.reason] };

    if (view?.state === "joined") return { title: `${hostName(view)}'s Jam`, lead: null };

    return { title: "You aren't in a Jam", lead: null };
  };

  const shown = notice();

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="flex w-full max-w-110 flex-col gap-5">
        <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">Jam</span>
        {shown === null ? (
          <p className="font-sans text-md/md text-text-muted">Joining…</p>
        ) : (
          <>
            <h1 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
              {shown.title}
            </h1>
            {shown.lead === null ? null : (
              <p className="font-sans text-md/md text-text-muted">{shown.lead}</p>
            )}
            <Link to="/" className={buttonClassName({ variant: "outline", size: "lg" })}>
              Go to Lar Music
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
