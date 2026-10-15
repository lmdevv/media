import { useAuthActions } from "@convex-dev/auth/react";
import { thisBrowserDeviceId } from "@music/player/react";
import { jamPreview } from "@music/sdk/functions";
import type { JamPreview } from "@music/sdk/functions";
import { useRead, useRun } from "@music/sdk/react";
import { Button, buttonClassName } from "@music/ui/components/button";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { useState } from "react";
import type { FormEvent } from "react";

import { AuthHeading, AuthLayout, Field } from "@/components/auth/auth-layout";
import { describeFailure, useAction } from "@/lib/action";

export const Route = createFileRoute("/jam/$code")({ component: JamPage });

const MIN_PASSWORD = 8;

const GUEST_EMAIL_KEY = "music.jamGuestEmail";

/** What a Jam link shows: whose Jam, what plays, how many are in, and how to join. */
function JamPage() {
  const { code } = Route.useParams();
  const preview = useQuery(jamPreview, { code });
  const { isLoading, isAuthenticated } = useConvexAuth();

  if (preview === undefined || isLoading) return <div className="min-h-dvh bg-bg" />;

  if (preview.state === "invalid" || preview.state === "ended") {
    return (
      <AuthLayout eyebrow="JAM">
        <AuthHeading
          title={preview.state === "ended" ? "This Jam has ended" : "This Jam link doesn't work"}
          lead={
            preview.state === "ended"
              ? "The host ended it, or it went quiet. Ask them to start a new one."
              : "It may have been replaced with a new link. Ask the host for the current one."
          }
        />
        <Link to="/" className={buttonClassName({ variant: "outline", size: "lg" })}>
          Go to [music]
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout eyebrow="JAM">
      <AuthHeading
        title={`Join ${preview.hostName}'s Jam`}
        lead={
          preview.state === "approval"
            ? `Listen along to what ${preview.hostName} plays. They let each person in.`
            : `Listen along to what ${preview.hostName} plays, and add songs to the queue.`
        }
      />
      {preview.state === "locked" ? (
        <p className="font-sans text-md/md text-text-muted">
          The host isn't letting anyone new in right now.
        </p>
      ) : isAuthenticated ? (
        <JoinJam code={code} preview={preview} />
      ) : (
        <SignedOutJoin code={code} guestAccounts={preview.guestAccounts} />
      )}
    </AuthLayout>
  );
}

/** Signed in: one button, which also makes this browser listen along. */
function JoinJam({
  code,
  preview,
}: {
  readonly code: string;
  readonly preview: Extract<JamPreview, { readonly hostName: string }>;
}) {
  const join = useRun("jam.join");
  const navigate = useNavigate();
  const me = useRead("account.me", {});
  // Set by the guest sign-up on this page; shown only to that guest, so a later account in the
  // same tab never sees it.
  const stored = window.sessionStorage.getItem(GUEST_EMAIL_KEY);
  const guestEmail = stored !== null && stored === me?.email ? stored : null;

  const [run, pending] = useAction(
    async () => {
      const joined = await join({ code, deviceId: thisBrowserDeviceId() });

      window.sessionStorage.removeItem(GUEST_EMAIL_KEY);

      await navigate({ to: "/" });

      return joined;
    },
    {
      success: (joined) =>
        joined.status === "pending"
          ? `Asked ${preview.hostName} to let you in`
          : "You're in the Jam",
    },
  );

  return (
    <div className="flex flex-col gap-3">
      <Button variant="primary" size="lg" pending={pending} onClick={() => void run()}>
        {preview.state === "approval" ? "Ask to join" : "Join"}
      </Button>
      <FieldHint>
        Your own music waits until you leave. You can add songs, and listen along here.
      </FieldHint>
      {guestEmail === null ? null : (
        <p className="rounded-md border border-border px-4 py-3 font-sans text-sm/sm text-text">
          Your guest account signs in as <strong>{guestEmail}</strong> with your password, so you
          can come back while the Jam lasts. It goes when the Jam ends.
        </p>
      )}
    </div>
  );
}

/** Signed out: sign in, or make a guest account when the server allows it. */
function SignedOutJoin({
  code,
  guestAccounts,
}: {
  readonly code: string;
  readonly guestAccounts: boolean;
}) {
  const redirect = `/jam/${code}`;

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/sign-in"
        search={{ redirect }}
        className={buttonClassName({ variant: guestAccounts ? "outline" : "solid", size: "lg" })}
      >
        Sign in to join
      </Link>
      {guestAccounts ? <GuestAccount code={code} /> : null}
    </div>
  );
}

/**
 * A guest account for this Jam: a name and a password. Guests hear nothing outside the Jams they
 * join, and the account goes when this Jam ends. The sign-in address is made up from the name and
 * shown, so they can come back meanwhile.
 */
function GuestAccount({ code }: { readonly code: string }) {
  const { signIn } = useAuthActions();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);

      return;
    }

    const handle = name
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "");

    const suffix = crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) ?? "guest";
    const email = `${handle.length === 0 ? "guest" : handle}-${suffix}@jam.local`;

    setPending(true);
    setError(null);

    try {
      await signIn("password", {
        email,
        password,
        name: name.trim(),
        jamCode: code,
        flow: "signUp",
      });
      window.sessionStorage.setItem(GUEST_EMAIL_KEY, email);
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      aria-label="Join as a guest"
      className="flex flex-col gap-4 border-t border-border pt-6"
      onSubmit={(event) => void submit(event)}
    >
      <span className="font-sans text-md/base font-semibold text-text">
        No account? Join as a guest
      </span>
      <Field>
        <FieldLabel htmlFor="jam-guest-name">Your name</FieldLabel>
        <Input
          id="jam-guest-name"
          autoComplete="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="jam-guest-password">Choose a password</FieldLabel>
        <Input
          id="jam-guest-password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={error !== null}
          aria-describedby="jam-guest-hint"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <FieldHint id="jam-guest-hint" tone={error === null ? "muted" : "danger"}>
          {error ?? `At least ${MIN_PASSWORD} characters. Guests hear only the Jam, until it ends.`}
        </FieldHint>
      </Field>
      <Button type="submit" variant="solid" size="lg" pending={pending}>
        Create guest account
      </Button>
    </form>
  );
}
