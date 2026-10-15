import { useAuthActions } from "@convex-dev/auth/react";
import { passwordResetLookup } from "@music/sdk/functions";
import type { PasswordResetDetails } from "@music/sdk/functions";
import { Button, buttonClassName } from "@music/ui/components/button";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";
import type { FormEvent } from "react";

import { AuthHeading, AuthLayout, Field } from "@/components/auth/auth-layout";
import { describeFailure } from "@/lib/action";
import { formatUntil } from "@/lib/format";
import { useNow } from "@/lib/use-now";

export const Route = createFileRoute("/reset/$token")({ component: ResetPage });

const host = window.location.host;

const MIN_PASSWORD = 8;

/** The page a password reset link opens: set a new password, then land signed in. */
function ResetPage() {
  const { token } = Route.useParams();
  const lookup = useQuery(passwordResetLookup, { token });
  const [resetting, setResetting] = useState(false);
  // The lookup says `open` as of its last change; expiry needs the clock.
  const now = useNow(60_000);

  if (lookup === undefined) return <div className="min-h-dvh bg-bg" />;

  if (lookup.state === "open" && lookup.expiresAt <= now && !resetting) {
    return <ResetUnavailable state="expired" />;
  }

  // Once used, the lookup flips to `used` while the new session starts; keep the form up.
  if (lookup.state === "open" || (resetting && lookup.state === "used")) {
    return <ResetForm token={token} reset={lookup} onResetting={setResetting} />;
  }

  return <ResetUnavailable state={lookup.state} />;
}

function ResetForm({
  token,
  reset,
  onResetting,
}: {
  readonly token: string;
  readonly reset: PasswordResetDetails;
  readonly onResetting: (resetting: boolean) => void;
}) {
  const { signIn } = useAuthActions();
  const navigate = useNavigate();
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
    onResetting(true);

    try {
      await signIn("password", { flow: "reset", token, newPassword: password });
      await navigate({ to: "/" });
    } catch (cause) {
      onResetting(false);
      setError(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout eyebrow="RESET PASSWORD">
      <AuthHeading
        title="Choose a new password"
        lead={`For ${reset.name ?? reset.email} on ${host}. You'll be signed out everywhere else. Signing in with the new password also turns off this person's API keys.`}
      />
      <form className="flex flex-col gap-7" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="reset-email">Email</FieldLabel>
            <Input
              id="reset-email"
              type="email"
              autoComplete="username"
              readOnly
              className="text-text-muted"
              value={reset.email}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="reset-password">New password</FieldLabel>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={error !== null}
              aria-describedby="reset-password-hint"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
            <FieldHint
              id="reset-password-hint"
              tone={error === null ? "muted" : "danger"}
              role={error === null ? undefined : "alert"}
            >
              {error ?? `At least ${MIN_PASSWORD} characters.`}
            </FieldHint>
          </Field>
        </div>
        <Button type="submit" variant="solid" size="lg" pending={pending}>
          {pending ? "Saving…" : "Set password and sign in"}
        </Button>
        <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">
          Link expires {formatUntil(reset.expiresAt)}
        </span>
      </form>
    </AuthLayout>
  );
}

function ResetUnavailable({ state }: { readonly state: "expired" | "used" | "invalid" }) {
  const copy = {
    expired: {
      title: "This reset link has expired",
      lead: "Reset links last 24 hours. Ask an admin for a new one from Settings → People.",
    },
    used: {
      title: "This reset link was already used",
      lead: "Each reset link works once. Sign in with your new password, or ask for another link.",
    },
    invalid: {
      title: "This reset link isn't valid",
      lead: "It may have been replaced by a newer link or mistyped. Ask an admin for a new one.",
    },
  }[state];

  return (
    <AuthLayout eyebrow="RESET PASSWORD">
      <AuthHeading title={copy.title} lead={copy.lead} />
      <Link to="/sign-in" className={buttonClassName({ variant: "outline", size: "lg" })}>
        Sign in
      </Link>
    </AuthLayout>
  );
}
