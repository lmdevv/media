import { useAuthActions } from "@convex-dev/auth/react";
import { commandFailure } from "@music/sdk/errors";
import { Button, buttonClassName } from "@music/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ErrorComponentProps, LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { describeFailure, isNotFoundFailure, useAction } from "@/lib/action";

/** Where a missing-item screen sends the user instead. */
interface BackLink {
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
}

/** The heading, explanation, and one action every failed or missing screen shows. */
function ScreenMessage({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh-message flex-col items-start justify-center gap-3 px-6 lg:px-12">
      <h1 className="font-sans text-xl/xl font-heavy tracking-tight text-text">{title}</h1>
      <p className="max-w-dialog font-sans text-md/md text-text-muted">{description}</p>
      {action}
    </div>
  );
}

function BackButton({ back }: { readonly back: BackLink }) {
  return (
    <Link to={back.to} className={buttonClassName({ variant: "solid" })}>
      {back.label}
    </Link>
  );
}

/**
 * Shown in place of a screen whose data failed to load. Under `/_app` it renders inside the
 * shell, so the sidebar and the player (and its audio) stay.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  // A session ended elsewhere (signed out, suspended, removed) fails every read; offer sign-in.
  if (error instanceof Error && commandFailure(error)?.code === "unauthenticated") {
    return <SignedOut message={describeFailure(error)} />;
  }

  return (
    <ScreenMessage
      title="This screen didn't load"
      description={describeFailure(error)}
      action={
        <Button variant="solid" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}

function SignedOut({ message }: { readonly message: string }) {
  const { signOut } = useAuthActions();
  const navigate = useNavigate();

  const [leave, leaving] = useAction(async () => {
    await signOut();
    await navigate({ to: "/sign-in" });
  });

  return (
    <ScreenMessage
      title="You're signed out"
      description={message}
      action={
        <Button variant="solid" pending={leaving} onClick={() => void leave()}>
          Sign in again
        </Button>
      }
    />
  );
}

/** Shown for a URL that matches no screen; signed in, `/_app/$` shows it inside the shell. */
export function PageNotFound() {
  return (
    <ScreenMessage
      title="There's nothing here"
      description="This link doesn't open anything in [music]. It may be mistyped."
      action={<BackButton back={{ to: "/", label: "Go to Home" }} />}
    />
  );
}

/** What a detail screen says when its item is gone, and where it sends the user. */
export interface MissingCopy {
  /** Shown when the server reports the item missing: deleted elsewhere, or a stale link. */
  readonly title: string;
  readonly description: string;
  readonly back: BackLink;
}

/**
 * A detail route's error screen: the "gone" state with a way back when the server reports the item
 * missing (deleted elsewhere, or a stale link), and {@link RouteError} for anything else.
 */
export function DetailError({
  copy,
  ...props
}: ErrorComponentProps & { readonly copy: MissingCopy }) {
  if (!(props.error instanceof Error && isNotFoundFailure(props.error))) {
    return <RouteError {...props} />;
  }

  return (
    <ScreenMessage
      title={copy.title}
      description={copy.description}
      action={<BackButton back={copy.back} />}
    />
  );
}
