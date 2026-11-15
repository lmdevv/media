import { usePlatform } from "@media/sdk/react";
import { Spinner } from "@media/ui/components/spinner";
import { describeFailure, isFailure } from "@media/ui/lib/failure";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { MOVIES } from "@/together/session";
import { SessionPage } from "@/together/session-states";
import type { SessionNotice } from "@/together/session-states";

/** Why a link cannot be joined, from the core's refusal. */
const refusalOf = (cause: unknown): SessionNotice => {
  if (isFailure(cause, "Expired")) return { kind: "ended", hostName: null };

  const message = describeFailure(cause);

  return isFailure(cause, "Forbidden") && /locked/iu.test(message)
    ? { kind: "locked" }
    : { kind: "refused", message };
};

/**
 * A group session's join link, `/together/<link>`: joins the person's movies session through it,
 * then opens the session page, which plays the session or says why it waits. A refused link says
 * why here: locked, ended, or not a session.
 */
export const Route = createFileRoute("/together/$link")({
  head: () => ({ meta: [{ title: "Watch together · [movies]" }] }),
  component: JoinPage,
});

const home = (className: string) => (
  <Link to="/" className={className}>
    Go to Home
  </Link>
);

function JoinPage() {
  const { link } = Route.useParams();
  const platform = usePlatform();
  const navigate = useNavigate();
  const [refused, setRefused] = useState<SessionNotice | null>(null);

  useEffect(() => {
    let active = true;

    platform.core.together.join({ domain: MOVIES, link }).then(
      () => {
        if (active) void navigate({ to: "/together", replace: true });

        return undefined;
      },
      (cause: unknown) => {
        if (active) setRefused(refusalOf(cause));
      },
    );

    return () => {
      active = false;
    };
  }, [platform, link, navigate]);

  if (refused !== null) return <SessionPage notice={refused} home={home} />;

  return (
    <div className="flex min-h-svh items-center justify-center bg-dark-bg">
      <Spinner className="size-12 text-text" label="Joining the session" />
    </div>
  );
}
