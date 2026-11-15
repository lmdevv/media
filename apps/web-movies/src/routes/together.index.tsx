import { usePlatform } from "@media/sdk/react";
import { Spinner } from "@media/ui/components/spinner";
import { describeFailure, isFailure, toastFailure } from "@media/ui/lib/failure";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useCurrentSession } from "@/together/current-session";
import { MOVIES, moviesItem, parseSessionLink } from "@/together/session";
import { SessionPage } from "@/together/session-states";
import type { SessionNotice } from "@/together/session-states";
import { useSessionTarget } from "@/together/use-session-target";

/** Why a link cannot be joined, from the core's refusal. */
const refusalOf = (cause: unknown): SessionNotice => {
  if (isFailure(cause, "Expired")) return { kind: "ended", hostName: null };

  const message = describeFailure(cause);

  return isFailure(cause, "Forbidden") && /locked/iu.test(message)
    ? { kind: "locked" }
    : { kind: "refused", message };
};

/** Where joining through the address's link stands. */
type Joining =
  | { readonly kind: "none" | "joining" | "joined" }
  | { readonly kind: "refused"; readonly notice: SessionNotice };

/**
 * The person's movies session, `/together`. A join link opens it as `/together#<link>`: the link
 * travels after `#`, so no request or referrer carries it, and it leaves the address and history
 * once read. The page joins through it, then opens the player on what the session plays, or says
 * why it cannot yet: waiting for the host, a locked or ended session, or an item the person may
 * not watch.
 */
export const Route = createFileRoute("/together/")({
  head: () => ({ meta: [{ title: "Watch together · [movies]" }] }),
  component: SessionRoute,
});

const home = (className: string) => (
  <Link to="/" className={className}>
    Go to Home
  </Link>
);

function SessionRoute() {
  const platform = usePlatform();
  const navigate = useNavigate();
  const view = useCurrentSession();
  const [link] = useState(() => parseSessionLink(window.location.hash.slice(1)));
  const [joining, setJoining] = useState<Joining>({ kind: link === null ? "none" : "joining" });
  const joined = view?.state === "joined" ? view : null;
  const target = useSessionTarget(moviesItem(joined?.item ?? null));
  const ready = joined !== null && target.status === "ready" ? target.target : null;

  useEffect(() => {
    if (link === null) return undefined;

    let active = true;

    window.history.replaceState(window.history.state, "", window.location.pathname);

    platform.core.together.join({ domain: MOVIES, link }).then(
      () => {
        if (active) setJoining({ kind: "joined" });

        return undefined;
      },
      (cause: unknown) => {
        if (active) setJoining({ kind: "refused", notice: refusalOf(cause) });
      },
    );

    return () => {
      active = false;
    };
  }, [platform, link]);

  useEffect(() => {
    if (ready === null || joining.kind === "joining") return;

    void navigate({
      to: "/watch/$titleId",
      params: { titleId: ready.titleId },
      search: ready.episodeId === null ? {} : { episodeId: ready.episodeId },
      replace: true,
    });
  }, [ready, joining.kind, navigate]);

  const leave = () => {
    void platform.core.together.leave({ domain: MOVIES }).catch(toastFailure);
  };

  if (joining.kind === "refused") return <SessionPage notice={joining.notice} home={home} />;

  const settling = joining.kind === "joining" || (joining.kind === "joined" && view === null);

  if (view === null && !settling) {
    return (
      <SessionPage
        notice={{ kind: "refused", message: "You aren't in a group session." }}
        home={home}
      />
    );
  }

  if (view?.state === "pending" && !settling) {
    return (
      <SessionPage notice={{ kind: "waiting", hostName: view.host }} home={home} onLeave={leave} />
    );
  }

  if (view?.state === "ended" && !settling) {
    return <SessionPage notice={{ kind: "ended", hostName: null }} home={home} />;
  }

  if (joined !== null && target.status === "unavailable" && !settling) {
    return <SessionPage notice={{ kind: "unavailable" }} home={home} onLeave={leave} />;
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-dark-bg">
      <Spinner className="size-12 text-text" label="Opening the session" />
    </div>
  );
}
