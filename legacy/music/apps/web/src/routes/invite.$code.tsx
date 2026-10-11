import { useAuthActions } from "@convex-dev/auth/react";
import { Redirect } from "@/components/redirect";
import { inviteLookup } from "@music/sdk/functions";
import type { InviteDetails } from "@music/sdk/functions";
import { Button, buttonClassName } from "@music/ui/components/button";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { useState } from "react";
import type { FormEvent } from "react";

import { AuthHeading, AuthLayout, Field } from "@/components/auth/auth-layout";
import { describeFailure } from "@/lib/action";
import { formatDate, formatUntil } from "@/lib/format";

export const Route = createFileRoute("/invite/$code")({ component: InvitePage });

const host = window.location.host;

const MIN_PASSWORD = 8;

function InvitePage() {
  const { code } = Route.useParams();
  const lookup = useQuery(inviteLookup, { code });
  const { isLoading, isAuthenticated } = useConvexAuth();
  const [joining, setJoining] = useState(false);

  if (lookup === undefined || isLoading) return <div className="min-h-dvh bg-bg" />;

  if (isAuthenticated) return <Redirect href="/" />;

  if (lookup.state === "open" || joining) {
    return lookup.state === "invalid" ? (
      <div className="min-h-dvh bg-bg" />
    ) : (
      <AcceptInvite code={code} invite={lookup} onJoining={setJoining} />
    );
  }

  return (
    <InviteUnavailable state={lookup.state} invite={lookup.state === "invalid" ? null : lookup} />
  );
}

function AcceptInvite({
  code,
  invite,
  onJoining,
}: {
  readonly code: string;
  readonly invite: InviteDetails;
  readonly onJoining: (joining: boolean) => void;
}) {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState(invite.email ?? "");
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

    setPending(true);
    setError(null);
    onJoining(true);

    try {
      await signIn("password", { email, password, name, inviteCode: code, flow: "signUp" });
    } catch (cause) {
      onJoining(false);
      setError(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout eyebrow="INVITE">
      <AuthHeading
        title={invite.inviterName === null ? "You're invited" : `${invite.inviterName} invited you`}
        lead={`Join ${host} to play the shared library and keep your own playlists and likes.`}
      />
      <form className="flex flex-col gap-7" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="invite-email">Email</FieldLabel>
            <Input
              id="invite-email"
              type="email"
              autoComplete="email"
              required
              readOnly={invite.email !== null}
              className={invite.email === null ? undefined : "text-text-muted"}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="invite-name">Your name</FieldLabel>
            <Input
              id="invite-name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="invite-password">Choose a password</FieldLabel>
            <Input
              id="invite-password"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={error !== null}
              aria-describedby="invite-password-hint"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldHint id="invite-password-hint" tone={error === null ? "muted" : "danger"}>
              {error ?? `At least ${MIN_PASSWORD} characters.`}
            </FieldHint>
          </Field>
        </div>
        <Button type="submit" variant="solid" size="lg" pending={pending}>
          {pending ? "Joining…" : "Join"}
        </Button>
        <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">
          Invite expires {formatUntil(invite.expiresAt)}
        </span>
      </form>
    </AuthLayout>
  );
}

function InviteUnavailable({
  state,
  invite,
}: {
  readonly state: "expired" | "used" | "invalid";
  readonly invite: InviteDetails | null;
}) {
  const inviter = invite?.inviterName ?? "the admin";

  const copy = {
    expired: {
      title: "This invite has expired",
      lead: `Invites last 7 days. Ask ${inviter} to send a new link from Settings → People.`,
    },
    used: {
      title: "This invite was already used",
      lead: "Each invite link works once. If it was yours, sign in instead.",
    },
    invalid: {
      title: "This invite isn't valid",
      lead: "The link may have been revoked or mistyped. Ask for a new one.",
    },
  }[state];

  return (
    <AuthLayout eyebrow="INVITE">
      <AuthHeading title={copy.title} lead={copy.lead} />
      {invite === null ? null : (
        <div className="flex items-center gap-2.5 rounded-md border border-border px-4 py-3.5">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
          <span className="font-sans text-base/sm text-text">
            {invite.email === null ? "Sent" : `Sent to ${invite.email}`} on{" "}
            {formatDate(invite.createdAt)}
            {state === "expired" ? ` · expired ${formatDate(invite.expiresAt)}` : ""}
          </span>
        </div>
      )}
      <Link to="/sign-in" className={buttonClassName({ variant: "outline", size: "lg" })}>
        I already have an account · Sign in
      </Link>
    </AuthLayout>
  );
}
