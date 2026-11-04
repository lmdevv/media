import type { InviteLookup } from "@media/contracts/models/account";
import { PASSWORD_MIN_LENGTH } from "@media/contracts/models/account";
import { useAuth, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { FieldError, TextField } from "@media/ui/components/text-field";
import { cn } from "@media/ui/lib/utils";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, LockIcon, SendIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { AuthPage, PageTitle, PasswordField } from "@/components/auth/auth-page";
import { avatarImage } from "@/lib/avatars";
import { describeFailure } from "@/lib/failure";
import { facts, formatDaysFrom, formatShortDate } from "@/lib/format";
import { BlankPage, Redirect } from "@/session/redirect";

export const Route = createFileRoute("/invite/$code")({
  head: () => ({ meta: [{ title: "Invite · [movies]" }] }),
  component: InvitePage,
});

type OpenInvite = Extract<InviteLookup, { readonly state: "open" | "used" | "expired" }>;

function InvitePage() {
  const { code } = Route.useParams();
  const { status } = useAuth();
  const lookup = useCommandQuery("invites.lookup", { code });

  if (status === "signedIn") return <Redirect href="/" />;

  if (status === "loading" || lookup.status === "loading") return <BlankPage />;

  if (lookup.status === "error" || lookup.data.state === "invalid") {
    return <EndedInvite invite={null} title="This invite isn't valid." />;
  }

  const invite = lookup.data;

  if (invite.state === "expired")
    return <EndedInvite invite={invite} title="This invite has expired." />;

  if (invite.state === "used")
    return <EndedInvite invite={invite} title="This invite was already used." />;

  return <AcceptInvite code={code} invite={invite} />;
}

function InviteHeader({
  title,
  detail,
  faded = false,
}: {
  readonly title: string;
  readonly detail: string;
  readonly faded?: boolean;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <img
        src={avatarImage("red")}
        alt=""
        className={cn("size-11 shrink-0 rounded-poster", faded && "opacity-40")}
      />
      <div className="flex min-w-0 grow basis-0 flex-col gap-0.5">
        <p className="text-body/5 font-semibold text-text">{title}</p>
        <p className="truncate font-mono text-caption/caption text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

function AcceptInvite({ code, invite }: { readonly code: string; readonly invite: OpenInvite }) {
  const { signInWithPassword } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invite.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Use at least ${PASSWORD_MIN_LENGTH} characters for the password.`);

      return;
    }

    setPending(true);
    setError(null);

    try {
      await signInWithPassword({
        flow: "signUp",
        name: name.trim(),
        email: (invite.email ?? email).trim(),
        password,
        inviteCode: code,
      });
      await navigate({ to: "/profiles", replace: true });
    } catch (cause) {
      setError(describeFailure(cause));
      setPending(false);
    }
  };

  return (
    <AuthPage offset="tight">
      <InviteHeader
        title={`${invite.inviterName} invited you to ${invite.inviterName}'s movies`}
        detail={facts(window.location.host, `expires ${formatShortDate(invite.expiresAt)}`)}
      />
      <PageTitle>You're invited.</PageTitle>
      <form className="flex flex-col gap-8" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-4">
          <TextField
            label="Your name"
            name="name"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {invite.email === null ? (
            <TextField
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          ) : (
            <TextField
              label="Email"
              name="email"
              type="email"
              readOnly
              value={invite.email}
              className="[&_input]:bg-transparent [&_input]:text-text-muted"
              trailing={
                <LockIcon className="size-4" strokeWidth={1.75} aria-label="Set by the invite" />
              }
            />
          )}
          <PasswordField
            label="Choose a password"
            labelAction={
              <span className="text-label/caption text-text-muted">
                {PASSWORD_MIN_LENGTH}+ characters
              </span>
            }
            name="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error === null ? null : <FieldError>{error}</FieldError>}
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          Accept and create account
          <ArrowRightIcon strokeWidth={2} aria-hidden />
        </Button>
      </form>
    </AuthPage>
  );
}

function EndedInvite({
  invite,
  title,
}: {
  readonly invite: OpenInvite | null;
  readonly title: string;
}) {
  const now = Date.now();

  const detail =
    invite === null
      ? null
      : invite.state === "expired"
        ? `Expired ${formatShortDate(invite.expiresAt)} · ${formatDaysFrom(invite.expiresAt, now)}`
        : `From ${invite.inviterName}`;

  const ask =
    invite === null
      ? null
      : `mailto:?subject=${encodeURIComponent("A new [movies] invite")}&body=${encodeURIComponent(
          `Hi ${invite.inviterName}, my [movies] invite ${invite.state === "expired" ? "expired" : "was already used"}. Could you send me a new one?`,
        )}`;

  return (
    <AuthPage offset="lead">
      {invite === null || detail === null ? null : (
        <InviteHeader
          title={
            invite.email === null
              ? `Invite from ${invite.inviterName}`
              : `Invite for ${invite.email}`
          }
          detail={detail}
          faded
        />
      )}
      <PageTitle>{title}</PageTitle>
      <div className="flex flex-col gap-4">
        {invite === null || ask === null ? null : (
          <a href={ask} className={cn(buttonVariants({ size: "lg" }), "w-full")}>
            <SendIcon strokeWidth={2} aria-hidden />
            Ask {invite.inviterName} for a new invite
          </a>
        )}
        <Link
          to="/sign-in"
          className={cn(buttonVariants({ variant: "subtle", size: "lg" }), "w-full")}
        >
          I already have an account
          <ArrowRightIcon strokeWidth={2} aria-hidden />
        </Link>
      </div>
    </AuthPage>
  );
}
