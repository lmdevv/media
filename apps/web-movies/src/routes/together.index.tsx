import { usePlatform } from "@media/sdk/react";
import { Spinner } from "@media/ui/components/spinner";
import { toastFailure } from "@media/ui/lib/failure";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useCurrentSession } from "@/together/current-session";
import { MOVIES, moviesItem } from "@/together/session";
import { SessionPage } from "@/together/session-states";
import { useSessionTarget } from "@/together/use-session-target";

/**
 * The person's movies session, `/together`: opens the player on what the session plays, or says
 * why it cannot yet: waiting for the host, a session that plays something they may not watch, or
 * one that ended.
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
  const joined = view?.state === "joined" ? view : null;
  const target = useSessionTarget(moviesItem(joined?.item ?? null));
  const ready = joined !== null && target.status === "ready" ? target.target : null;

  useEffect(() => {
    if (ready === null) return;

    void navigate({
      to: "/watch/$titleId",
      params: { titleId: ready.titleId },
      search: ready.episodeId === null ? {} : { episodeId: ready.episodeId },
      replace: true,
    });
  }, [ready, navigate]);

  const leave = () => {
    void platform.core.together.leave({ domain: MOVIES }).catch(toastFailure);
  };

  if (view === null) {
    return (
      <SessionPage
        notice={{ kind: "refused", message: "You aren't in a group session." }}
        home={home}
      />
    );
  }

  if (view?.state === "pending") {
    return (
      <SessionPage notice={{ kind: "waiting", hostName: view.host }} home={home} onLeave={leave} />
    );
  }

  if (view?.state === "ended") {
    return <SessionPage notice={{ kind: "ended", hostName: null }} home={home} />;
  }

  if (joined !== null && target.status === "unavailable") {
    return <SessionPage notice={{ kind: "unavailable" }} home={home} onLeave={leave} />;
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-dark-bg">
      <Spinner className="size-12 text-text" label="Opening the session" />
    </div>
  );
}
